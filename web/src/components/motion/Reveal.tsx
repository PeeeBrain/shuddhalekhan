import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Seconds to wait before the reveal starts — used to stagger siblings. */
  delay?: number;
  /** Vertical travel in px. */
  y?: number;
  once?: boolean;
};

/**
 * Fade-and-rise entrance when the element scrolls into view.
 * Transform/opacity only; collapses to a static render for reduced motion.
 */
export function Reveal({ children, className, delay = 0, y = 28, once = true }: RevealProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: '-72px' }}
      transition={{ duration: 0.8, delay, ease: EASE_OUT_EXPO }}
    >
      {children}
    </motion.div>
  );
}
