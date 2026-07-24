import { Download } from 'lucide-react';
import { LatestWindowsDownloadLink } from '@/components/LatestWindowsDownloadLink';

export function Cta() {
  return (
    <>
      <section className="relative z-10 border-t border-zinc-800/60 px-6 py-20">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-indigo-400/20 bg-[#10111a] px-6 py-14 text-center sm:px-12">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(129,140,248,0.16),transparent_58%)]" />
          <div className="relative">
            <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-300">Your voice. Your computer. Your rules.</div>
            <h2 className="mx-auto mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-5xl">Stop paying monthly to type with your voice.</h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-400 sm:text-base">Download Shuddhalekhan and start dictating across Windows. Free, open source, and yours to configure.</p>
            <LatestWindowsDownloadLink className="mx-auto mt-8 flex h-12 w-fit items-center gap-2 rounded-full bg-white px-7 text-sm font-semibold text-zinc-950 transition hover:bg-indigo-100 active:scale-95">
              <Download className="size-4" /> Download for Windows
            </LatestWindowsDownloadLink>
            <div className="mt-4 text-[11px] text-zinc-500">Windows 10/11 · x64</div>
          </div>
        </div>
      </section>

      {/* Minimal Footer */}
      <footer className="relative z-10 border-t border-zinc-900 bg-[#07080a] py-8 text-center text-[11px] text-zinc-500 font-mono">
        <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>Shuddhalekhan · Free &amp; Open Source Desktop App</div>
          <div className="flex items-center gap-5">
            <a href="https://github.com/PeeeBrain/shuddhalekhan/releases/latest" target="_blank" rel="noreferrer" className="hover:text-zinc-300 transition">Releases</a>
            <a href="https://github.com/PeeeBrain/shuddhalekhan/issues" target="_blank" rel="noreferrer" className="hover:text-zinc-300 transition">Report an issue</a>
            <a href="https://github.com/PeeeBrain/shuddhalekhan" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-zinc-300 transition">
              <svg className="size-3.5 fill-current" viewBox="0 0 1024 1024" aria-hidden="true">
                <path fillRule="evenodd" d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0" clipRule="evenodd" />
              </svg>
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
