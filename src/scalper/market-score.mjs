const DEFAULT_CONFIDENCE = Object.freeze({
  'completed-sale': 0.9,
  'market-price': 0.75,
  'active-listing': 0.35,
  appraisal: 0.25,
});

const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const money = (value) => Number(value.toFixed(2));
const ratio = (value) => Number(value.toFixed(4));

function latestBySource(observations) {
  const latest = new Map();
  for (const observation of observations) {
    const key = `${observation.source}:${observation.kind}`;
    if (!latest.has(key) || observation.at > latest.get(key).at) latest.set(key, observation);
  }
  return [...latest.values()];
}

function evidenceSummary(observations) {
  const current = latestBySource(observations);
  let weightTotal = 0;
  let priceTotal = 0;
  let confidenceTotal = 0;
  let sampleSize = 0;
  for (const observation of current) {
    const confidence = clamp(Number(observation.confidence ?? DEFAULT_CONFIDENCE[observation.kind] ?? 0.2));
    const sample = Math.max(1, Number(observation.sampleSize) || 1);
    const weight = confidence * Math.min(3, 1 + Math.log10(sample));
    priceTotal += Number(observation.price) * weight;
    confidenceTotal += confidence * weight;
    weightTotal += weight;
    sampleSize += sample;
  }
  if (!weightTotal) return null;
  const ordered = [...observations].sort((a, b) => a.at - b.at);
  const first = ordered[0]?.price;
  const last = ordered.at(-1)?.price;
  const trend = Number(first) > 0 && ordered.length > 1 ? (Number(last) - Number(first)) / Number(first) : 0;
  return {
    price: priceTotal / weightTotal,
    confidence: confidenceTotal / weightTotal,
    sampleSize,
    trend,
    current,
  };
}

export function scoreProduct(product, observations = [], defaults = {}, now = Date.now()) {
  const relevant = observations.filter((item) => item.productId === product.id && Number(item.price) > 0);
  const evidence = evidenceSummary(relevant);
  const acquisitionPrice = Number(product.acquisitionPrice ?? product.msrp);
  const risks = [];
  if (!Number.isFinite(acquisitionPrice) || acquisitionPrice <= 0) risks.push('missing-acquisition-price');
  if (!evidence) risks.push('missing-market-evidence');
  const activeOnly = evidence?.current.every((item) => item.kind === 'active-listing') ?? false;
  if (activeOnly) risks.push('active-listings-only');
  if (evidence && evidence.sampleSize < 3) risks.push('low-sample-size');
  const unreleased = Number.isFinite(Date.parse(product.releaseDate)) && Date.parse(product.releaseDate) > now;
  if (unreleased) risks.push('presale-market');

  if (risks.includes('missing-acquisition-price') || risks.includes('missing-market-evidence')) {
    return {
      id: product.id, name: product.name, score: 0, eligible: false,
      acquisitionPrice: Number.isFinite(acquisitionPrice) ? acquisitionPrice : null,
      marketPrice: evidence ? money(evidence.price) : null,
      confidence: evidence ? ratio(evidence.confidence) : 0,
      risks,
    };
  }

  const acquisitionTaxRate = Number(defaults.acquisitionTaxRate) || 0;
  const sellingFeeRate = Number(defaults.sellingFeeRate) || 0;
  const fixedFee = Number(defaults.paymentFeeFlat) || 0;
  const shipping = Number(product.outboundShipping ?? defaults.outboundShipping) || 0;
  const acquisitionCost = acquisitionPrice * (1 + acquisitionTaxRate);
  const netProceeds = evidence.price * (1 - sellingFeeRate) - fixedFee - shipping;
  const profit = netProceeds - acquisitionCost;
  const roi = profit / acquisitionCost;
  const liquidity = clamp(Math.log1p(evidence.sampleSize) / Math.log(21));
  const trend = clamp(evidence.trend, -0.5, 0.5);

  const profitScore = clamp(profit / Math.max(50, Number(defaults.minProfit) || 1)) * 35;
  const roiScore = clamp(roi) * 30;
  const liquidityScore = liquidity * 10;
  const adjustedConfidence = evidence.confidence * (unreleased ? 0.75 : 1);
  const confidenceScore = adjustedConfidence * 20;
  const trendScore = ((trend + 0.5) / 1) * 5;
  const score = Number(clamp(profitScore + roiScore + liquidityScore + confidenceScore + trendScore, 0, 100).toFixed(1));

  const minProfit = Number(defaults.minProfit) || 0;
  const minRoi = Number(defaults.minRoi) || 0;
  const minConfidence = Number(defaults.minConfidence) || 0;
  if (profit < minProfit) risks.push('profit-below-threshold');
  if (roi < minRoi) risks.push('roi-below-threshold');
  if (adjustedConfidence < minConfidence) risks.push('confidence-below-threshold');

  return {
    id: product.id,
    name: product.name,
    releaseDate: product.releaseDate ?? null,
    score,
    eligible: profit >= minProfit && roi >= minRoi && adjustedConfidence >= minConfidence,
    acquisitionPrice: money(acquisitionPrice),
    acquisitionCost: money(acquisitionCost),
    marketPrice: money(evidence.price),
    estimatedNetProceeds: money(netProceeds),
    estimatedProfit: money(profit),
    roi: ratio(roi),
    confidence: ratio(adjustedConfidence),
    sampleSize: evidence.sampleSize,
    trend: ratio(evidence.trend),
    evidence: evidence.current.map((item) => ({ source: item.source, kind: item.kind, price: item.price, at: item.at })),
    risks,
  };
}

export function rankProducts(products, observations, defaults, now) {
  return products
    .map((product) => scoreProduct(product, observations, defaults, now))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || (b.estimatedProfit ?? -Infinity) - (a.estimatedProfit ?? -Infinity));
}
