#!/bin/bash
# gcp-gpu-eval — run the CHAMPION pipeline on a CAPABLE model, FAST, on a GPU box.
#
# The whole-session compute wall was CPU inference. An L4 runs a 7B 20-50x faster, so the full
# n=30 baseline/brain/champion eval finishes in minutes. Autonomous startup-script (no SSH):
# installs the NVIDIA driver + ollama (GPU) + the capable model, pulls code + brain + bank from
# GCS, runs the champion bench, pushes the scoreboard, self-deletes. HARD SHUTDOWN guard.
#
# Lessons baked in: HOME=/root (or ollama pull panics), robust model pull + abort-if-missing
# (don't run to a 0 result), log streamed to GCS every 30s.
#
# PREREQ: $GCS/brain-complete.tar.gz, $GCS/code/agent-machine/, $GCS/mmlu_stem.json
# Usage:  GCP_PROJECT=socioprophet-platform bash scripts/gcp-gpu-eval.sh
set -euo pipefail
PROJECT="${GCP_PROJECT:-socioprophet-platform}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM="${VM_NAME:-champ-eval}"
MACHINE="${MACHINE:-g2-standard-8}"          # 1x NVIDIA L4 (24GB) — fits 7B and 14B
GCS="gs://sourceos-artifacts-socioprophet/ocw-corpus"
SA="${GCP_SA:-sourceos-ci@socioprophet-platform.iam.gserviceaccount.com}"
MODEL="${MODEL:-qwen2.5:7b}"
ARMS="${ARMS:-baseline,brain}"           # the core run; champion(verify) is too slow over big fields on CPU
PER="${PER:-30}"
MAXCHUNKS="${MAXCHUNKS:-30000}"          # per-field pool cap — keeps JS cosine fast (math is 150k otherwise)
SUBJECTS="${SUBJECTS:-high_school_biology,conceptual_physics,electrical_engineering,college_chemistry,high_school_statistics,college_mathematics,abstract_algebra}"
TERM_TIME="${TERM_TIME:-$(python3 -c "import datetime;print((datetime.datetime.now().astimezone()+datetime.timedelta(hours=4)).replace(microsecond=0).isoformat())")}"

cat > /tmp/gpu-eval-startup.sh <<STARTUP
#!/bin/bash
exec >/var/log/eval-run.log 2>&1; set -x
export HOME=/root
GCS="$GCS"
( while true; do gsutil -q cp /var/log/eval-run.log "\$GCS/eval-run.log" 2>/dev/null; sleep 30; done ) & LOGPID=\$!
step(){ echo "==== \$(date '+%H:%M:%S') \$* ===="; gsutil -q cp /var/log/eval-run.log "\$GCS/eval-run.log" 2>/dev/null||true; }

step "wait for NVIDIA driver"
for i in \$(seq 1 60); do nvidia-smi >/dev/null 2>&1 && break; sleep 10; done
nvidia-smi || echo "WARN: no GPU visible (will run slow)"

step "install ollama (GPU)"
curl -fsSL https://ollama.com/install.sh | sh
systemctl stop ollama 2>/dev/null || true
OLLAMA_NUM_PARALLEL=8 OLLAMA_MAX_LOADED_MODELS=2 OLLAMA_KEEP_ALIVE=30m nohup ollama serve >/var/log/ollama.log 2>&1 &
sleep 12
for n in 1 2 3 4 5; do ollama pull $MODEL && break; echo "model retry \$n"; sleep 8; done
for n in 1 2 3 4 5; do ollama pull nomic-embed-text && break; echo "embed retry \$n"; sleep 8; done
ollama list | grep -q nomic-embed-text || { echo "FATAL: embed model missing"; exit 1; }

step "install node + python + pull code + brain + bank"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs git python3-pip
pip3 install --break-system-packages -q sympy numpy scikit-learn || pip3 install -q sympy numpy scikit-learn
mkdir -p /opt/am && gsutil -m cp -r "\$GCS/code/agent-machine/*" /opt/am/ && cd /opt/am && npm ci
mkdir -p /opt/OCW && gsutil cp "\$GCS/brain-complete.tar.gz" /tmp/b.tgz && tar xzf /tmp/b.tgz -C /opt/OCW
mkdir -p /root/.noetica/corpus/benchmarks && gsutil cp "\$GCS/mmlu_stem.json" /root/.noetica/corpus/benchmarks/mmlu_stem.json

step "run CHAMPION eval — $MODEL · arms=$ARMS · n=$PER · seed=1729"
OLLAMA_HOST=http://127.0.0.1:11434 OCW_BRAIN=/opt/OCW/_brain \
  MMLU_MODEL=$MODEL MMLU_ARMS=$ARMS MMLU_PER_SUBJECT=$PER MMLU_SEED=1729 MMLU_SUBJECTS=$SUBJECTS MMLU_MAX_CHUNKS=$MAXCHUNKS MMLU_CONC=8 \
  bash scripts/run-exam.sh 2>&1 | tee /var/log/scoreboard.txt || echo "EVAL EXITED \$?"
gsutil cp /var/log/scoreboard.txt "\$GCS/bench/champion-$MODEL.txt" || true

step "DONE — self-deleting"
kill \$LOGPID 2>/dev/null||true; gsutil -q cp /var/log/eval-run.log "\$GCS/eval-run.log"||true
N=\$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/name)
Z=\$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/zone | awk -F/ '{print \$NF}')
gcloud compute instances delete "\$N" --zone="\$Z" --quiet
STARTUP

echo "# creating $VM ($MACHINE · L4 GPU) — champion eval on $MODEL, HARD SHUTDOWN at $TERM_TIME"
gcloud compute instances create "$VM" --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" --maintenance-policy=TERMINATE \
  --image-family=common-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release \
  --metadata="install-nvidia-driver=True" --metadata-from-file startup-script=/tmp/gpu-eval-startup.sh \
  --boot-disk-size=120GB --service-account="$SA" --scopes=cloud-platform \
  --termination-time="$TERM_TIME" --instance-termination-action=DELETE

echo "# launched. watch:  gsutil cat $GCS/eval-run.log   ·   scoreboard → $GCS/bench/champion-$MODEL.txt"
