/** Locale-owned video renderer labels and status text. */
export const zh = {
  title: '视频',
  preview: '视频预览：{name}',
  loading: '正在读取视频信息…',
  failed: '无法播放这段视频',
  unsupported: '当前应用基址无法提供视频文件地址',
} satisfies Record<string, string>

/** Video renderer dictionary keys. */
type VideoPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Video',
  preview: 'Video preview: {name}',
  loading: 'Reading video metadata…',
  failed: 'This video could not be played.',
  unsupported: 'The current application base URL cannot serve this video file.',
} satisfies Record<VideoPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video preview selection, accessible name, and status text. */
    sidebarVideo: VideoPreviewKey
  }
}

/** Japanese dictionary, checked against the English keys. */
export const ja = {
  title: '動画',
  preview: '動画プレビュー: {name}',
  loading: '動画のメタデータを読み込み中…',
  failed: 'この動画を再生できませんでした。',
  unsupported: '現在のアプリケーションベース URL ではこの動画ファイルを配信できません。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Vídeo',
  preview: 'Vista previa del vídeo: {name}',
  loading: 'Leyendo los metadatos del vídeo…',
  failed: 'No se pudo reproducir este vídeo.',
  unsupported: 'La URL base actual de la aplicación no puede servir este archivo de vídeo.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Vidéo',
  preview: 'Aperçu de la vidéo : {name}',
  loading: 'Lecture des métadonnées de la vidéo…',
  failed: 'Cette vidéo n’a pas pu être lue.',
  unsupported: 'L’URL de base actuelle de l’application ne peut pas servir ce fichier vidéo.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Video',
  preview: 'Videovorschau: {name}',
  loading: 'Videometadaten werden gelesen…',
  failed: 'Dieses Video konnte nicht abgespielt werden.',
  unsupported: 'Die aktuelle Anwendungsbasis-URL kann diese Videodatei nicht bereitstellen.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Видео',
  preview: 'Предварительный просмотр видео: {name}',
  loading: 'Чтение метаданных видео…',
  failed: 'Не удалось воспроизвести это видео.',
  unsupported: 'Текущий базовый адрес приложения не может передать этот видеофайл.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Vídeo',
  preview: 'Visualização do vídeo: {name}',
  loading: 'A ler os metadados do vídeo…',
  failed: 'Não foi possível reproduzir este vídeo.',
  unsupported: 'O URL base atual da aplicação não pode servir este ficheiro de vídeo.',
} satisfies Record<keyof typeof en, string>
