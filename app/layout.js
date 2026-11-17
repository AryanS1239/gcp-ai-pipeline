import './globals.css';

export const metadata = {
  title: 'AI Image Processor',
  description: 'GCP Vision API powered receipt & document OCR pipeline',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
