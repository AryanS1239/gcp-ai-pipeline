'use client';

import { useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export default function HomePage() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | uploading | processing | done | error
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [results, setResults] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // --- Drag & Drop handlers ---
  const onDrop = useCallback((e) => {
    e.preventDefault();
    const dropped = e.dataTransfer?.files?.[0] || e.target.files?.[0];
    if (!dropped) return;
    if (!ACCEPTED_TYPES.includes(dropped.type)) {
      setErrorMsg('Please upload a JPG, PNG, WEBP, or GIF image.');
      return;
    }
    setFile(dropped);
    setPreview(URL.createObjectURL(dropped));
    setStatus('idle');
    setResult(null);
    setErrorMsg('');
  }, []);

  // --- Upload flow ---
  const handleUpload = async () => {
    if (!file) return;
    setStatus('uploading');
    setProgress(0);
    setErrorMsg('');

    try {
      // Record time just before upload so polling only catches NEW results
      const uploadStartedAt = new Date().toISOString();

      // Send file directly to our API route — it proxies to GCS server-side
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');

      // Track upload progress
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };

      const uploadedFileName = await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status === 200) {
            const { fileName } = JSON.parse(xhr.responseText);
            resolve(fileName);
          } else {
            const msg = (() => { try { return JSON.parse(xhr.responseText)?.error; } catch { return null; } })();
            reject(new Error(msg || `Upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(formData);
      });

      // Poll Supabase for Vision API results (Cloud Function processes async)
      setStatus('processing');
      setProgress(100);
      await pollForResult(uploadedFileName, uploadStartedAt);    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || 'Something went wrong');
      setStatus('error');
    }
  };

  const pollForResult = async (since, attempts = 0) => {
    if (attempts > 20) {
      setErrorMsg('Processing timed out. Check back in a moment.');
      setStatus('error');
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await supabase
      .from('image_results')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (data) {
      setResult(data);
      setStatus('done');
    } else {
      await pollForResult(since, attempts + 1);
    }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    const { data } = await supabase
      .from('image_results')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setResults(data || []);
    setLoadingHistory(false);
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">🧠 AI Image Processor</h1>
          <p className="text-gray-400 mt-1 text-sm">Upload a receipt or document — Vision API extracts text & labels automatically</p>
        </div>

        {/* Drop Zone */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => document.getElementById('fileInput').click()}
        >
          <input id="fileInput" type="file" accept="image/*" className="hidden" onChange={onDrop} />
          {preview ? (
            <img src={preview} alt="Preview" className="max-h-48 mx-auto rounded-lg object-contain" />
          ) : (
            <div className="text-gray-500 space-y-2">
              <div className="text-4xl">📄</div>
              <p>Drag & drop an image here, or click to select</p>
              <p className="text-xs">JPG, PNG, WEBP, GIF supported</p>
            </div>
          )}
        </div>

        {file && (
          <p className="text-center text-sm text-gray-400">
            Selected: <span className="text-white font-medium">{file.name}</span> ({(file.size / 1024).toFixed(1)} KB)
          </p>
        )}

        {/* Upload Button */}
        <button
          onClick={handleUpload}
          disabled={!file || status === 'uploading' || status === 'processing'}
          className="w-full py-3 rounded-lg font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {status === 'uploading' ? `Uploading... ${progress}%`
            : status === 'processing' ? '⏳ Processing with Vision API...'
            : '🚀 Upload & Analyze'}
        </button>

        {/* Progress Bar */}
        {(status === 'uploading' || status === 'processing') && (
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${status === 'processing' ? 100 : progress}%` }}
            />
          </div>
        )}

        {/* Error */}
        {errorMsg && (
          <div className="bg-red-900/40 border border-red-700 text-red-300 rounded-lg p-4 text-sm">
            ❌ {errorMsg}
          </div>
        )}

        {/* Result */}
        {status === 'done' && result && (
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold text-green-400">✅ Analysis Complete</h2>

            {result.extracted_text && (
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-1">📝 Extracted Text (OCR)</h3>
                <pre className="bg-gray-800 rounded-lg p-3 text-sm text-gray-200 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {result.extracted_text}
                </pre>
              </div>
            )}

            {result.labels?.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-2">🏷️ Labels Detected</h3>
                <div className="flex flex-wrap gap-2">
                  {result.labels.map((l, i) => (
                    <span key={i} className="bg-blue-900/50 text-blue-300 text-xs px-3 py-1 rounded-full border border-blue-700">
                      {l.description} <span className="text-blue-500">{Math.round(l.score * 100)}%</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-gray-600">
              Stored at {new Date(result.created_at).toLocaleString()}
            </p>
          </div>
        )}

        {/* History */}
        <div className="border-t border-gray-800 pt-6">
          <button
            onClick={loadHistory}
            disabled={loadingHistory}
            className="text-sm text-blue-400 hover:text-blue-300 underline disabled:opacity-50"
          >
            {loadingHistory ? 'Loading...' : '📋 View recent results'}
          </button>

          {results.length > 0 && (
            <div className="mt-4 space-y-3">
              {results.map((r) => (
                <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex gap-4 items-start">
                  <img src={r.image_url} alt="" className="w-16 h-16 object-cover rounded-lg flex-shrink-0 bg-gray-800" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-500">{new Date(r.created_at).toLocaleString()}</p>
                    <p className="text-sm text-gray-200 truncate mt-1">
                      {r.extracted_text?.slice(0, 100) || <span className="text-gray-600 italic">No text detected</span>}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {r.labels?.slice(0, 4).map((l, i) => (
                        <span key={i} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                          {l.description}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
