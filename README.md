# 🧠 GCP AI Image Processing Pipeline

A serverless pipeline that extracts text (OCR) and labels from uploaded images using Google Cloud Vision API, with results stored in Supabase.

## Architecture

```
Browser → Next.js → GCS Bucket → Cloud Function → Vision API → Supabase
```

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 + Tailwind CSS |
| Storage | Google Cloud Storage |
| Backend | Cloud Functions Gen2 (Node.js 22) |
| AI | Google Cloud Vision API |
| Database | Supabase (PostgreSQL) |

## Setup

### 1. Clone & install
```bash
git clone https://github.com/AryanS1239/gcp-ai-pipeline.git
cd gcp-ai-pipeline
npm install
```

### 2. Configure environment
```bash
cp .env.example .env.local
# Fill in your values in .env.local
```

### 3. Auth (required for signed URL generation)
```bash
gcloud auth application-default login
```

### 4. Run locally
```bash
npm run dev
```

## GCP Resources

- **Project**: `gcp-ai-pipeline-515018`
- **Bucket**: `gcp-ai-pipeline-uploads` (asia-south1)
- **Function**: `process-image` (asia-south1)
- **Service Account**: `gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com`

## Supabase

- **Project**: `gcp-ai-pipeline`
- **Table**: `image_results`

## Deploy Cloud Function

```bash
gcloud functions deploy process-image \
  --gen2 --runtime=nodejs22 --region=asia-south1 \
  --source=./functions \
  --entry-point=processImage \
  --trigger-event-filters="type=google.cloud.storage.object.v1.finalized" \
  --trigger-event-filters="bucket=gcp-ai-pipeline-uploads" \
  --set-env-vars="SUPABASE_URL=...,SUPABASE_ANON_KEY=..." \
  --service-account=gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com \
  --memory=256Mi --timeout=120s \
  --project=gcp-ai-pipeline-515018 --quiet
```
