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
  "Too many requests waiting": {
    "zh-Hans": "等待中的请求过多",
    "zh-Hant": "等待中的請求過多",
    ja: "待機中のリクエストが多すぎます",
    ko: "대기 중인 요청이 너무 많습니다",
    fr: "Trop de requêtes en attente",
  },
  "Approve or deny the requests already waiting in Tivano, then try again.": {
    "zh-Hans": "请先在 Tivano 中批准或拒绝等待中的请求，然后重试。",
    "zh-Hant": "請先在 Tivano 中核准或拒絕等待中的請求，然後重試。",
    ja: "Tivano で待機中のリクエストを承認または拒否してから、もう一度お試しください。",
    ko: "Tivano에서 대기 중인 요청을 먼저 승인하거나 거부한 뒤 다시 시도하세요.",
    fr: "Approuvez ou refusez d’abord les demandes en attente dans Tivano, puis réessayez.",
  },
  "Request expired": {
    "zh-Hans": "请求已过期",
    "zh-Hant": "請求已過期",
    ja: "リクエストの有効期限が切れました",
    ko: "요청이 만료됨",
    fr: "Demande expirée",
  },
  "Start the connection again from your agent.": {
    "zh-Hans": "请从智能体重新发起连接。",
    "zh-Hant": "請從代理重新發起連線。",
    ja: "エージェントから接続をやり直してください。",
    ko: "에이전트에서 연결을 다시 시작하세요.",
    fr: "Relancez la connexion depuis votre agent.",
  },
  "Approve on your computer": {
    "zh-Hans": "在你的电脑上批准",
    "zh-Hant": "在電腦上核准",
    ja: "お使いのコンピューターで承認",
    ko: "이 컴퓨터에서 승인",
    fr: "Approuver sur votre ordinateur",
  },
  "Tivano is waiting for you to approve %@ on your computer. Check that Tivano shows this code:": {
    "zh-Hans": "Tivano 正在等待你在电脑上批准 %@。请确认 Tivano 显示以下验证码：",
    "zh-Hant": "Tivano 正在等待你在電腦上核准 %@。請確認 Tivano 顯示以下驗證碼：",
    ja: "Tivano はコンピューター上で %@ の承認を待っています。Tivano に次のコードが表示されていることを確認してください：",
    ko: "Tivano가 이 컴퓨터에서 %@ 승인을 기다리고 있습니다. Tivano에 다음 코드가 표시되는지 확인하세요:",
    fr: "Tivano attend que vous approuviez %@ sur votre ordinateur. Vérifiez que Tivano affiche ce code :",
  },
  "This page refreshes by itself. You can close it after your agent says it is connected.": {
    "zh-Hans": "此页面会自动刷新。智能体提示已连接后，你可以关闭此页面。",
    "zh-Hant": "此頁面會自動重新整理。代理提示已連線後，即可關閉此頁面。",
    ja: "このページは自動的に更新されます。エージェントが接続完了と表示したら閉じて構いません。",
    ko: "이 페이지는 자동으로 새로 고침됩니다. 에이전트에서 연결됨을 확인한 후 이 페이지를 닫아도 됩니다.",
    fr: "Cette page s’actualise automatiquement. Vous pouvez la fermer une fois que votre agent indique qu’il est connecté.",
  },
  "Connection request not valid": {
    "zh-Hans": "连接请求无效",
    "zh-Hant": "連線請求無效",
    ja: "接続リクエストが無効です",
    ko: "연결 요청이 유효하지 않습니다",
    fr: "Demande de connexion non valide",
  },
  "This client or its return address is not registered with Tivano.": {
    "zh-Hans": "此客户端或其返回地址未在 Tivano 中注册。",
    "zh-Hant": "此用戶端或其回傳位址尚未向 Tivano 註冊。",
    ja: "このクライアントまたはその戻り先アドレスは Tivano に登録されていません。",
    ko: "이 클라이언트 또는 반환 주소가 Tivano에 등록되어 있지 않습니다.",
    fr: "Ce client ou son adresse de retour n’est pas enregistré auprès de Tivano.",
  },
} as const satisfies Record<string, Record<Exclude<LanguageId, "en">, string>>;

export function mainT(
  lang: LanguageId,
  key: keyof typeof MAIN_STRINGS,
  vars?: string[],
): string {
  let s = lang === "en" ? (key as string) : MAIN_STRINGS[key][lang];
  if (vars?.length) {
    let i = 0;
    s = s.replace(/%@|%d/g, (m) => (i < vars.length ? vars[i++]! : m));
  }
  return s;
}
