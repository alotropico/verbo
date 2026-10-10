export const IPC_CHANNELS = {
  threadsList: 'verbo:threads:list',
  threadsInitialize: 'verbo:threads:initialize',
  threadsRename: 'verbo:threads:rename',
  threadsArchive: 'verbo:threads:archive',
  threadsUnarchive: 'verbo:threads:unarchive',
  threadsDelete: 'verbo:threads:delete',
  threadsFetch: 'verbo:threads:fetch',
  threadsGenerateTitle: 'verbo:threads:generateTitle',
  messagesLoad: 'verbo:messages:load',
  messagesAppend: 'verbo:messages:append',
  ollamaStatus: 'verbo:ollama:status',
  ollamaWelcomeLine: 'verbo:ollama:welcomeLine',
  settingsGet: 'verbo:settings:get',
  settingsSet: 'verbo:settings:set'
} as const
