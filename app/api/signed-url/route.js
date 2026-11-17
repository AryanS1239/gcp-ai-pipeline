import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  // Uses GOOGLE_APPLICATION_CREDENTIALS env var automatically
});

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
