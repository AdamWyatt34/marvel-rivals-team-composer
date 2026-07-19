import { z } from "zod";

/**
 * Probability-calibration parameters fitted by the backtest against real
 * match outcomes (scripts/backtest). Optional input: without it the engine
 * runs at temperature 1 (uncalibrated).
 */

export const CALIBRATION_SCHEMA_VERSION = 1;

export const calibrationSchema = z.object({
  schemaVersion: z.literal(CALIBRATION_SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  band: z.string().min(1),
  /** Sigmoid temperature: P = sigmoid(zBar + T*(z - zBar)). */
  temperature: z.number().positive().max(20),
  nPredictions: z.number().int().nonnegative(),
});

export type Calibration = z.infer<typeof calibrationSchema>;
