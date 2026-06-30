#!/bin/bash
# gcp-kgbert-encode — run the KG-BERT encode over the discovered HellGraph on an L4.
#   Pulls the staged kg-export artifacts (entities/triples/hyperedges) + kg-bert-encode.py from GCS,
#   runs `score` (triple-plausibility held-out accuracy — does the graph cohere?) then `embed`
#   (entity/hyperedge vectors → .npz), uploads both, and SELF-DELETES the VM so it never idles.
#   Multi-zone for L4 stockout. Stream the log: gcloud storage cat <GCS>/kg-bert/run.log
#
# Usage: bash scripts/gcp-kgbert-encode.sh         # one-shot; ~$1-2 of L4
set -uo pipefail
PROJECT="${GCP_PROJECT:-socioprophet-platform}"
GCS="gs://sourceos-artifacts-socioprophet/ocw-corpus"
SA="${GCP_SA:-sourceos-ci@socioprophet-platform.iam.gserviceaccount.com}"
VM="kgbert-encode"
MODEL="${KGBERT_MODEL:-bert-base-uncased}"
EPOCHS="${KGBERT_EPOCHS:-1}"
KG="$GCS/kg-export"           # staged entities/triples/hyperedges.jsonl
OUT="$GCS/kg-bert"            # results land here
ZONES="${ZONES:-us-east1-d us-east4-a us-east4-c us-west1-a us-west1-b us-west4-a us-central1-a us-central1-b us-central1-c asia-southeast1-a asia-southeast1-b asia-southeast1-c us-south1-a europe-west4-a}"
TERM=$(python3 -c "import datetime;print((datetime.datetime.now().astimezone()+datetime.timedelta(hours=4)).replace(microsecond=0).isoformat())")

ex=$(gcloud compute instances list --project=$PROJECT --filter="name=$VM" --format="value(name)" 2>/dev/null)
[ -n "$ex" ] && { echo "ABORT — $VM already exists (a run is in flight)"; exit 0; }
echo "# kgbert-encode · model=$MODEL · kg=$KG · out=$OUT"

cat > /tmp/kgbert-startup.sh <<STARTUP
#!/bin/bash
export HOME=/root; mkdir -p /root/.noetica/kg
exec >/var/log/kgbert.log 2>&1; set -x
GCS="$GCS"
# sidecar: stream the log to GCS every 15s so the run is observable
( while true; do gsutil -q cp /var/log/kgbert.log "$OUT/run.log" 2>/dev/null; sleep 15; done ) &
step(){ echo "==== \$(date '+%H:%M:%S') \$* ===="; }

step "wait GPU"; for i in \$(seq 1 60); do nvidia-smi >/dev/null 2>&1 && break; sleep 10; done
nvidia-smi || { step "FATAL-no-gpu"; gsutil -q cp /var/log/kgbert.log "$OUT/run.log"; }

step "deps — common-cu129 has the CUDA DRIVER but NOT torch, and bare 'pip' isn't on the startup PATH; use the
python3 already on PATH via 'python3 -m pip'. Install torch (cu124 wheel, driver-580 compatible) + transformers."
PIP="python3 -m pip"
\$PIP --version || python3 -m ensurepip --default-pip
\$PIP install -q torch --index-url https://download.pytorch.org/whl/cu124 2>&1 | tail -3 || \$PIP install -q torch 2>&1 | tail -3
\$PIP install -q --upgrade transformers numpy 2>&1 | tail -2
python3 -c "import torch; print('torch', torch.__version__, 'cuda?', torch.cuda.is_available())" || { step "FATAL-torch-missing"; gsutil -q cp /var/log/kgbert.log "$OUT/run.log"; }

step "pull artifacts + encoder"
gsutil -q cp "$KG/entities.jsonl"   /root/.noetica/kg/entities.jsonl
gsutil -q cp "$KG/triples.jsonl"    /root/.noetica/kg/triples.jsonl
gsutil -q cp "$KG/hyperedges.jsonl" /root/.noetica/kg/hyperedges.jsonl
gsutil -q cp "$GCS/code/agent-machine/scripts/kg-bert-encode.py" /root/kg-bert-encode.py
wc -l /root/.noetica/kg/*.jsonl

step "SCORE — triple-plausibility held-out accuracy (does the graph cohere?)"
python3 /root/kg-bert-encode.py --mode score --model "$MODEL" --device cuda --epochs $EPOCHS 2>&1 | tee /root/score.txt
gsutil -q cp /root/score.txt "$OUT/score-$MODEL.txt"

step "EMBED — entity + hyperedge vectors → .npz"
python3 /root/kg-bert-encode.py --mode embed --model "$MODEL" --device cuda --out /root/kg-bert-embeddings.npz 2>&1 | tail -5
gsutil -q cp /root/kg-bert-embeddings.npz "$OUT/kg-bert-embeddings.npz"

step "DONE — uploading final log + self-deleting"
gsutil -q cp /var/log/kgbert.log "$OUT/run.log"
N=\$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/name)
Z=\$(curl -s -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/zone|awk -F/ '{print \$NF}')
gcloud compute instances delete "\$N" --zone="\$Z" --quiet
STARTUP

for Z in $ZONES; do
  echo "  trying $VM in $Z"
  if gcloud compute instances create $VM --project=$PROJECT --zone=$Z --machine-type=g2-standard-8 \
      --maintenance-policy=TERMINATE --image-family=common-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release \
      --metadata=install-nvidia-driver=True --metadata-from-file startup-script=/tmp/kgbert-startup.sh \
      --boot-disk-size=200GB --service-account=$SA --scopes=cloud-platform \
      --termination-time="$TERM" --instance-termination-action=DELETE >/dev/null 2>&1; then
    echo "=== kgbert-encode LAUNCHED in $Z — poll: gcloud storage cat $OUT/run.log ==="
    exit 0
  fi
  echo "    $Z failed (stockout?), next"
done
echo "FATAL — all zones failed"; exit 1
