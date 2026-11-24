// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import type { LanguageId } from "../shared/types";

export const MAIN_STRINGS = {
  "Tivano Windows Dev — Terminal validation candidate": {
    "zh-Hans": "Tivano Windows Dev — 终端验证候选版",
    "zh-Hant": "Tivano Windows Dev — 終端機驗證候選版",
    ja: "Tivano Windows Dev — ターミナル検証候補版",
    ko: "Tivano Windows Dev — 터미널 검증 후보 버전",
    fr: "Tivano Windows Dev — version candidate de validation du terminal",
  },
  "Open folder": {
    "zh-Hans": "打开文件夹",
    "zh-Hant": "開啟資料夾",
    ja: "フォルダーを開く",
    ko: "폴더 열기",
    fr: "Ouvrir un dossier",
  },
  "Choose Codex executable": {
    "zh-Hans": "选择 Codex 程序",
    "zh-Hant": "選擇 Codex 執行檔",
    ja: "Codex 実行ファイルを選択",
    ko: "Codex 실행 파일 선택",
    fr: "Choisir l’exécutable Codex",
  },
  "Choose a path": {
    "zh-Hans": "选择路径",
    "zh-Hant": "選擇路徑",
    ja: "パスを選択",
    ko: "경로 선택",
    fr: "Choisir un chemin",
  },
  Attach: {
    "zh-Hans": "添加附件",
    "zh-Hant": "加入附件",
    ja: "ファイルを添付",
    ko: "파일 첨부",
    fr: "Joindre",
  },
  "Choose picture": {
    "zh-Hans": "选择图片",
    "zh-Hant": "選擇圖片",
    ja: "画像を選択",
    ko: "사진 선택",
    fr: "Choisir une image",
  },
  Images: {
    "zh-Hans": "图片",
    "zh-Hant": "圖片",
    ja: "画像",
    ko: "이미지",
    fr: "Images",
  },
  "Could not finish closing cleanly": {
    "zh-Hans": "无法彻底完成关闭",
    "zh-Hant": "無法完全完成關閉",
    ja: "終了処理を正常に完了できませんでした",
    ko: "종료 처리를 완전히 끝내지 못했습니다",
    fr: "Impossible de terminer la fermeture proprement",
  },
  "Nothing was deleted; the data file and child processes were left untouched where their state was uncertain.": {
    "zh-Hans": "未删除任何数据；状态不确定的数据文件和子进程均已保留原样。",
    "zh-Hant": "未刪除任何資料；狀態不確定的資料檔案與子處理程序皆已保留原樣。",
    ja: "何も削除されていません。状態が不確定なデータファイルおよび子プロセスはそのまま残されました。",
    ko: "삭제된 항목이 없습니다. 상태가 불확실한 데이터 파일과 하위 프로세스는 그대로 유지되었습니다.",
    fr: "Rien n’a été supprimé ; le fichier de données et les processus enfants dont l’état était incertain ont été laissés intacts.",
  },
  Retry: {
    "zh-Hans": "重试",
    "zh-Hant": "重試",
    ja: "再試行",
    ko: "다시 시도",
    fr: "Réessayer",
  },
  "Keep open (read-only)": {
    "zh-Hans": "保持打开（只读）",
    "zh-Hant": "保持開啟（唯讀）",
    ja: "開いたままにする（読み取り専用）",
    ko: "열린 상태 유지(읽기 전용)",
    fr: "Laisser ouvert (lecture seule)",
  },
} as const satisfies Record<string, Record<Exclude<LanguageId, "en">, string>>;

export function mainT(lang: LanguageId, key: keyof typeof MAIN_STRINGS): string {
  return lang === "en" ? key : MAIN_STRINGS[key][lang];
}
