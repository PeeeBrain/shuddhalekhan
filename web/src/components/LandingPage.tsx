import { Header } from '@/components/landing/Header';
import { Hero } from '@/components/landing/Hero';
import { AgentSection } from '@/components/landing/AgentSection';
import { Principles } from '@/components/landing/Principles';
import { Story } from '@/components/landing/Story';
import { Cta } from '@/components/landing/Cta';

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip">
      <Header />
      <main>
        <Hero />
        <AgentSection />
        <Principles />
        <Story />
      </main>
      <Cta />
    </div>
  );
}
