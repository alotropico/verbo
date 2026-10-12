export async function bootDev({ runDev, log }) {
  log("Verbo owns Ollama and voice after the app process starts.");
  runDev();
}
