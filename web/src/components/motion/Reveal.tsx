import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Seconds to wait before the reveal starts; used to stagger siblings. */
  delay?: number;
};

/**
 * Short fade-and-rise when the element scrolls into view, once.
 * Transform/opacity only; renders static under reduced motion.
 */
export function Reveal({ children, className, delay = 0 }: RevealProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-64px' }}
      transition={{ duration: 0.6, delay, ease: EASE_OUT_QUART }}
    >
      {children}
    </motion.div>
  );
}
