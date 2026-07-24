import { Header } from '@/components/landing/Header';
import { Hero } from '@/components/landing/Hero';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { AgentSection } from '@/components/landing/AgentSection';
import { Story } from '@/components/landing/Story';
import { Cta } from '@/components/landing/Cta';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#07080a] text-zinc-100 font-sans selection:bg-zinc-700 selection:text-white">
      {/* Ambient background glow - static subtle glow without strobing pulse */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[1200px] h-[450px] bg-gradient-to-b from-indigo-500/10 via-purple-500/5 to-transparent blur-3xl pointer-events-none" />

      <Header />
      <Hero />
      <HowItWorks />
      <AgentSection />
      <Story />
      <Cta />
    </div>
  );
}
