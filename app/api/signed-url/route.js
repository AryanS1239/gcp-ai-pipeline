import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

// Support both local file-based credentials and Vercel env-var credentials
const getStorage = () => {
  if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    // Vercel: service account JSON stored as env var string
    const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    return new Storage({ projectId: process.env.GCP_PROJECT_ID, credentials });
  }
  // Local: uses GOOGLE_APPLICATION_CREDENTIALS file path
  return new Storage({ projectId: process.env.GCP_PROJECT_ID });
};

const storage = getStorage();

const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const SIGNED_URL_EXPIRY_MINUTES = 10;

export async function POST(request) {
  try {
    const { fileName, fileType } = await request.json();

    if (!fileName || !fileType) {
      return NextResponse.json(
        { error: 'fileName and fileType are required' },
        { status: 400 }
      );
    }

    // Sanitize filename: strip path traversal, keep extension
    const safeFileName = `uploads/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const [signedUrl] = await storage
      .bucket(BUCKET_NAME)
      .file(safeFileName)
      .generateSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + SIGNED_URL_EXPIRY_MINUTES * 60 * 1000,
        contentType: fileType,
      });

    return NextResponse.json({ signedUrl, safeFileName });
  } catch (err) {
    console.error('[signed-url] Error generating signed URL:', err.message);
    return NextResponse.json(
      { error: 'Failed to generate upload URL' },
      { status: 500 }
    );
  }
}
