export async function bootDev({
  ensureOllama,
  verifyModel,
  ensureVoice,
  runDev,
  log,
}) {
  await ensureOllama();
  await verifyModel();
  const voiceState = await ensureVoice();
  log(voiceState.detail);
  runDev();
  return voiceState;
}
