import { factorMeta, type FactorKey, type FactorScores, type ForecastHorizon } from "@/lib/terminal-data";

export type TrainingExample = {
  features: FactorScores;
  label: 0 | 1;
  asOf?: string;
  pair?: string;
  labelEnd?: string;
  horizon?: ForecastHorizon;
};

export type WalkForwardMode = "expanding" | "rolling";

export type WalkForwardFold = {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  trainSamples: number;
  testSamples: number;
  purgedSamples: number;
  accuracy: number;
  logLoss: number;
  brierScore: number;
};

const factors = Object.keys(factorMeta) as FactorKey[];

function normalize(weights: FactorScores) {
  const total = factors.reduce((sum, factor) => sum + Math.max(0, weights[factor]), 0);
  return Object.fromEntries(factors.map((factor) => [
    factor,
    total > 0 ? Math.max(0, weights[factor]) / total : 1 / factors.length,
  ])) as FactorScores;
}

export function partiallyPoolWeights(
  horizonWeights: FactorScores,
  globalWeights: FactorScores,
  sampleCount: number,
  priorStrength = 80,
) {
  const share = Math.max(0, sampleCount) / (Math.max(0, sampleCount) + Math.max(1, priorStrength));
  return normalize(Object.fromEntries(factors.map((factor) => [
    factor,
    globalWeights[factor] * (1 - share) + horizonWeights[factor] * share,
  ])) as FactorScores);
}

function probability(features: FactorScores, weights: FactorScores) {
  const logit = factors.reduce((sum, factor) => sum + features[factor] * weights[factor], 0) * 5;
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))));
}

function evaluate(examples: TrainingExample[], weights: FactorScores) {
  const epsilon = 1e-9;
  const predictions = examples.map((example) => ({
    probability: probability(example.features, weights),
    label: example.label,
  }));
  return {
    accuracy: predictions.reduce((sum, item) => sum + Number((item.probability >= 0.5) === Boolean(item.label)), 0) / predictions.length,
    logLoss: -predictions.reduce((sum, item) => (
      sum + item.label * Math.log(Math.max(epsilon, item.probability))
      + (1 - item.label) * Math.log(Math.max(epsilon, 1 - item.probability))
    ), 0) / predictions.length,
    brierScore: predictions.reduce((sum, item) => sum + (item.probability - item.label) ** 2, 0) / predictions.length,
  };
}

export function trainLearnedWeights(
  examples: TrainingExample[],
  initial: FactorScores,
  epochs = 420,
) {
  if (examples.length < 20) throw new Error("At least 20 labeled examples are required");
  let weights = normalize({ ...initial });
  const learningRate = 0.12;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Object.fromEntries(factors.map((factor) => [factor, 0])) as FactorScores;
    for (const example of examples) {
      const error = probability(example.features, weights) - example.label;
      for (const factor of factors) gradient[factor] += error * example.features[factor];
    }
    for (const factor of factors) {
      const regularized = gradient[factor] / examples.length + weights[factor] * 0.01;
      weights[factor] = Math.max(0.001, weights[factor] - learningRate * regularized);
    }
    weights = normalize(weights);
  }

  return { weights, logLoss: evaluate(examples, weights).logLoss };
}

export function walkForwardValidate(
  examples: TrainingExample[],
  initial: FactorScores,
  options: {
    mode?: WalkForwardMode;
    minimumTrainSamples?: number;
    testSamples?: number;
    rollingTrainSamples?: number;
    maxFolds?: number;
  } = {},
) {
  const mode = options.mode ?? "expanding";
  const minimumTrainSamples = Math.max(20, options.minimumTrainSamples ?? 40);
  const testSamples = Math.max(1, options.testSamples ?? 20);
  const rollingTrainSamples = Math.max(minimumTrainSamples, options.rollingTrainSamples ?? 180);
  const maxFolds = Math.max(1, options.maxFolds ?? 12);
  const ordered = [...examples]
    .map((example, index) => ({ ...example, asOf: example.asOf?.slice(0, 10) ?? `synthetic-${String(index).padStart(8, "0")}` }))
    .sort((a, b) => a.asOf.localeCompare(b.asOf));

  const groups: { asOf: string; examples: TrainingExample[] }[] = [];
  for (const example of ordered) {
    const current = groups.at(-1);
    if (current?.asOf === example.asOf) current.examples.push(example);
    else groups.push({ asOf: example.asOf, examples: [example] });
  }

  let trainEnd = 0;
  let trainCount = 0;
  while (trainEnd < groups.length && trainCount < minimumTrainSamples) {
    trainCount += groups[trainEnd].examples.length;
    trainEnd += 1;
  }

  const folds: WalkForwardFold[] = [];
  while (trainEnd < groups.length && folds.length < maxFolds) {
    let testEnd = trainEnd;
    let currentTestSamples = 0;
    while (testEnd < groups.length && currentTestSamples < testSamples) {
      currentTestSamples += groups[testEnd].examples.length;
      testEnd += 1;
    }
    if (!currentTestSamples) break;

    let trainStart = 0;
    if (mode === "rolling") {
      let rollingCount = 0;
      trainStart = trainEnd;
      while (trainStart > 0 && rollingCount < rollingTrainSamples) {
        trainStart -= 1;
        rollingCount += groups[trainStart].examples.length;
      }
    }
    const testStart = groups[trainEnd].asOf;
    const unpurgedTrainSet = groups.slice(trainStart, trainEnd).flatMap((group) => group.examples);
    const trainSet = unpurgedTrainSet.filter((example) => !example.labelEnd || example.labelEnd.slice(0, 10) < testStart);
    const testSet = groups.slice(trainEnd, testEnd).flatMap((group) => group.examples);
    if (!testSet.length) break;
    if (trainSet.length < minimumTrainSamples) {
      trainEnd += 1;
      continue;
    }
    const trained = trainLearnedWeights(trainSet, initial, 180);
    const metrics = evaluate(testSet, trained.weights);
    folds.push({
      trainStart: groups[trainStart].asOf,
      trainEnd: groups[trainEnd - 1].asOf,
      testStart: groups[trainEnd].asOf,
      testEnd: groups[testEnd - 1].asOf,
      trainSamples: trainSet.length,
      testSamples: testSet.length,
      purgedSamples: unpurgedTrainSet.length - trainSet.length,
      ...metrics,
    });
    trainEnd = testEnd;
  }

  if (!folds.length) throw new Error("Not enough chronological observations for walk-forward validation");
  const sampleCount = folds.reduce((sum, fold) => sum + fold.testSamples, 0);
  const weighted = (key: "accuracy" | "logLoss" | "brierScore") => (
    folds.reduce((sum, fold) => sum + fold[key] * fold.testSamples, 0) / sampleCount
  );
  return {
    mode,
    folds,
    sampleCount,
    accuracy: weighted("accuracy"),
    logLoss: weighted("logLoss"),
    brierScore: weighted("brierScore"),
  };
}
