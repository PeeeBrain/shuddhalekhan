export type ScheduledBuildRun = {
  buildLabel: string;
  repetition: number;
};

export function createAbbaSchedule(options: {
  baselineLabel: string;
  candidateLabel: string;
  repetitionsPerBuild: number;
}): ScheduledBuildRun[] {
  if (!Number.isInteger(options.repetitionsPerBuild) || options.repetitionsPerBuild < 2) {
    throw new Error('ABBA scheduling requires at least two repetitions per build');
  }
  if (options.repetitionsPerBuild % 2 !== 0) {
    throw new Error('ABBA scheduling requires an even repetition count per build');
  }

  const schedule: ScheduledBuildRun[] = [];
  for (let offset = 0; offset < options.repetitionsPerBuild; offset += 2) {
    schedule.push(
      { buildLabel: options.baselineLabel, repetition: offset + 1 },
      { buildLabel: options.candidateLabel, repetition: offset + 1 },
      { buildLabel: options.candidateLabel, repetition: offset + 2 },
      { buildLabel: options.baselineLabel, repetition: offset + 2 },
    );
  }
  return schedule;
}

export async function executeAbbaSchedule(options: {
  outputRoot: string;
  schedule: ScheduledBuildRun[];
  runOne: (run: ScheduledBuildRun & { outputDir: string }) => Promise<void>;
  betweenRuns?: () => Promise<void>;
}): Promise<void> {
  for (let index = 0; index < options.schedule.length; index += 1) {
    const scheduled = options.schedule[index];
    if (!scheduled) continue;
    const ordinal = String(index + 1).padStart(3, '0');
    const repetition = String(scheduled.repetition).padStart(3, '0');
    const outputDir = join(
      options.outputRoot,
      `${ordinal}-${scheduled.buildLabel}-${repetition}`,
    );
    await options.runOne({ ...scheduled, outputDir });
    if (index < options.schedule.length - 1) {
      await options.betweenRuns?.();
    }
  }
}
import { join } from 'path';
