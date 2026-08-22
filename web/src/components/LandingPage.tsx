import { Header } from '@/components/landing/Header';
import { Hero } from '@/components/landing/Hero';
import { DictationSection } from '@/components/landing/DictationSection';
import { AgentSection } from '@/components/landing/AgentSection';
import { Principles } from '@/components/landing/Principles';
import { Story } from '@/components/landing/Story';
import { Cta } from '@/components/landing/Cta';

export function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground antialiased">
      {/* Page-level vignette keeps edges ink-dark so signal glows read as intentional */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 bg-[linear-gradient(to_bottom,transparent_92%,rgba(0,0,0,0.5)),linear-gradient(to_right,black,transparent_6%,transparent_94%,black)] opacity-60"
      />
      <Header />
      <main>
        <Hero />
        <DictationSection />
        <AgentSection />
        <Principles />
        <Story />
      </main>
      <Cta />
    </div>
  );
}
