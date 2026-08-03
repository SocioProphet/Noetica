# Receipt gateway overlay

Routes noetica's `agent-machine` model calls through the receipt-emitting gateway so every
completion/embedding is recorded as a governed, hash-chained `InferenceReceipt` — no app
code change.

```
docker compose -f docker-compose.yml -f docker-compose.receipts.yml up -d
```

`docker-compose.receipts.yml` adds a `receipt-gateway` service in front of `ollama`
(`RECEIPT_GATEWAY_BACKEND=http://ollama:11434`) and overrides `agent-machine`'s
`OLLAMA_HOST` to `http://receipt-gateway:8898`. The gateway (from
`SociOS-Linux/workstation-contracts`, `deploy/receipt-gateway`) forwards Ollama `/api/chat`,
`/api/generate`, `/api/embeddings` (emitting a receipt with the request's real model digest,
per `RECEIPT_GATEWAY_MODEL_DIGESTS`) and passes non-inference endpoints (`/api/tags`,
`/api/show`) straight through, so `agent-machine` behaves identically. Receipts persist on
the `receipt-ledger` volume. Base compose is untouched — the overlay is opt-in.
