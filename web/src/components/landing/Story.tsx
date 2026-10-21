import { Reveal } from '@/components/motion/Reveal';

export function Story() {
  return (
    <section id="why-open-source" className="scroll-mt-20 border-t border-border/60 py-24 md:py-36">
      <div className="mx-auto grid max-w-6xl items-start gap-x-16 gap-y-10 px-6 lg:grid-cols-12">
        {/* The name, set as a dictionary entry */}
        <Reveal className="lg:col-span-12">
          <p lang="mr" className="font-deva text-[clamp(4.5rem,2rem+10vw,10rem)] leading-[1.1] font-semibold tracking-[-0.01em]">
            शुद्धलेखन
          </p>
        </Reveal>

        <Reveal className="lg:col-span-5">
          <p className="max-w-[40ch] text-[17px] leading-relaxed text-muted-foreground">
            <span className="text-foreground">shud·dha·le·khan</span> is Marathi for "correct writing", meaning text
            with correct spelling and grammar.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="lg:col-span-6 lg:col-start-7">
          <figure>
            <blockquote className="text-[clamp(1.25rem,1rem+0.8vw,1.5rem)] leading-snug font-medium tracking-[-0.01em] text-pretty">
              "I wanted touch-free typing that could run locally, remain open source, and leave people in control of
              their data and their AI providers."
            </blockquote>
            <figcaption className="mt-6 text-[14px] text-muted-foreground">
              <span className="font-semibold text-foreground">Partha Shirolkar</span>, creator
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
