import type { DestinationKey } from "@/lib/notifications/destinations";
import type { MessageOptions } from "@/lib/notifications/channel";
import { operationalInterestCard } from "@/lib/platform/operational-events";
export interface SlackExample { id:string; destination:DestinationKey; text:string; options:MessageOptions; image?:boolean }
const at="2026-10-29T00:30:00Z";
const actions:MessageOptions["components"]=[{type:1,components:[{type:2,style:3,label:"확인",custom_id:"synthetic:confirm"},{type:2,style:2,label:"취소",custom_id:"synthetic:cancel"}]}];
const card=(id:string,destination:DestinationKey,title:string,text:string,extra:MessageOptions={}):SlackExample=>({id,destination,text,options:{embed:{title,footer:"합성 자료",timestamp:at},...extra}});
const reward=operationalInterestCard({version:1,eventId:"synthetic_reward_001",occurredAt:at,type:"ad.reward.delivered",appId:"sample",outcome:"delivered",attributes:{provider:"admob",placementId:"daily_bonus",rewardKey:"crystal",rewardAmount:0}},"예제 앱");
export const slackDestinationExamples:SlackExample[]=[
 card("backoffice","backoffice","승인 대기","**예제 앱 출시 요청**\n변경 내용과 대상 마켓을 확인하세요.\n\n[실행 근거](https://example.com/evidence)",{components:actions}),
 {...card("metrics-daily","metrics-daily","오늘 운영보고","**이용자 1,240명, 어제보다 8% 증가**\n\n## 주요 수치\n- 매출 32,000원\n- 수집 누락: 미제공\n\n[상세 보고서](https://example.com/report)"),image:true},
 card("action-events","action-events","앱 이벤트","**예제 앱 1.2.3** 신규 계정 1명 · 09:30 KST",{plain:true}),
 card("release-ops","release-ops","빌드 업로드 완료","예제 앱 1.2.3\n\n처리 중입니다. 심사와 공개 상태는 아직 확인되지 않았습니다.",{components:actions}),
 card("ops-alerts","ops-alerts","⚠️ 보상 지급 실패","**영향: 광고 시청 후 보상을 받지 못한 주문 1건**\n지급 원장에서 실패와 재시도 결과를 확인하세요.\n\n오류: `PROVIDER_TIMEOUT`",{components:actions}),
 card("batch-monitoring","batch-monitoring","수집 일부 실패","**완료 12개, 실패 1개**\n\n> 실패 대상의 원본 응답을 확인하세요.\n\n실제 0: 0원\n미수집: 미제공"),
 card("seori-review","seori-review","개발 검토가 필요합니다","**현재 상태: 검토 대기**\n\n1. 변경 범위 확인\n2. 재현 근거 확인\n\n```text\n기대: 저장 후 유지\n관측: 재실행 후 초기화\n```",{components:actions}),
 {id:"private-feed",destination:"private-feed",text:"기존 호환 뉴스",options:{presentation:{layout:"newsletter",title:"📰 오늘의 기술 뉴스 · 3건",items:[{title:"긴 제목: 새로운 도구가 업무 흐름에 미치는 영향과 실제 적용 사례를 확인했습니다",summary:"**검증된 결과**를 바탕으로 작업 시간이 줄었습니다.\n\n다음 관측에서는 실패와 복구도 확인합니다.",url:"https://example.com/news/1?a=1&b=2"},{title:"특수문자 A & B, <예제>와 별표",summary:"인용과 링크를 구분합니다. [발표 자료](https://example.com/source)",url:"https://example.com/news/2"},{title:"후속 기사",summary:"원문에 없는 결론을 추가하지 않습니다.",url:"https://example.com/news/3"}],context:["합성 자료, 실제 뉴스가 아닙니다."],timestamp:at}}},
 card("user-reviews","user-reviews","새 사용자 리뷰","**예제 앱 · ★★★★☆**\n\n> 설정을 찾기 쉬워졌습니다.\n\n[스토어 리뷰 보기](https://example.com/review)"),
 {...card("app-ops","app-ops","일일 재무보고","**수익 32,000원, 비용 12,000원**\n순수익 20,000원\n전일 대비 수익 8% 증가\n\n[상세 재무보고](https://example.com/finance)"),image:true},
 {id:"iap",destination:"iap",text:"결제 구분",options:{presentation:{title:"💳 결제 권리 지급 완료",fields:[{label:"앱",value:"예제 앱"},{label:"주문 구분",value:"테스트 주문"},{label:"지급 항목",value:"premium"}],timestamp:at}}},
 {id:"ad-rewards",destination:"ad-rewards",text:reward.text,options:{presentation:reward.presentation}},
 card("github-issues","github-issues","개발 이슈 등록","**예제 앱의 저장 오류**\n현재 상태: 열림\n\n[이슈 보기](https://example.com/issues/1)"),
];
const commandResponses:Record<string,[string,string]>={
 help:["운영 명령 안내","`/seori app status app:sample`\n\n조회 명령은 결과를 표시하고 변경 명령은 확인과 취소를 거칩니다."],
 "account connect":["계정 연결 완료","GitHub 계정을 연결했습니다. 앱의 쓰기 권한은 작업 실행 시 다시 확인합니다."],
 "app status":["예제 앱 현황","개발 단계: 개발 중\n최근 빌드: 성공\n공개 상태: 미확인"],
 "app metrics":["예제 앱 지표","이용자 0명\n매출: 미제공\n\n[지표 보기](https://example.com/metrics)"],
 "app report":["종합 보고서","**이용자는 증가했고 결제 자료는 일부 미수집입니다.**\n\n## 근거\n- 이용자 1,240명\n- 결제 수집률 80%\n\n## 확인할 항목\n실패한 수집을 확인하세요."],
 "app reviews":["최근 리뷰","**새 리뷰 0건**\n수집은 정상 완료됐습니다."],
 "app keywords":["검색어 노출 관측","앱 이름: 12위\n요청 국가: 미국\n적용 국가: 미확인"],
 "app health":["수집 상태","⚠️ 1개 수집 실패\n실패한 원본 응답을 확인하세요."],
 "app insights":["최근 인사이트","**초기 안내 완료율이 8%p 높아졌습니다.**\n\n[집계 근거](https://example.com/insight)"],
 "issue create":["이슈 등록 확인","**예제 앱의 오류 수정 요청**\n등록하면 대상 저장소에 이슈가 생성됩니다."],
 "issue plan":["기획 초안 확인","목적: 초기 안내 단축\n성공 기준: 완료율 개선\n\n원문과 근거를 확인하세요."],
 "issue bug":["버그 보고 확인","재현: 저장 후 다시 실행\n기대: 값 유지\n관측: 값 초기화"],
 "issue approvals":["승인 대기","**대기 중인 요청 1건**\n\n[요청 보기](https://example.com/approval)"],
 "issue urgent":["긴급 이슈","현재 열린 긴급 이슈가 없습니다."],
 "release create":["릴리스 생성 확인","예제 앱 1.2.3\n태그와 출시노트가 생성됩니다."],
 "release deploy":["배포 실행 확인","예제 앱 1.2.3\n대상: Google Play 내부 테스트\n공개 배포 상태는 별도로 확인합니다."],
 "release snapshot":["내부 테스트 빌드 확인","현재 main의 고정된 코드를 빌드합니다.\n기존 테스트 데이터는 유지합니다."],
 "note save":["메모 저장 완료","받은함에 메모를 저장했습니다.\n\n[문서 보기](https://example.com/note)"],
 "note index":["문서 색인 완료","처리 12개, 실패 0개"],
 "chat ask":["질문 답변","**관측 자료가 부족합니다.**\n\n> 결제 수집이 끝난 뒤 같은 기간을 비교하세요.\n\n[수집 상태](https://example.com/health)"],
 "chat reset":["대화 초기화 완료","내 Slack 대화 문맥을 초기화했습니다."],
};
export const slackCommandExamples:SlackExample[]=Object.entries(commandResponses).map(([path,[title,text]])=>card(`command:${path}`,"backoffice",title,text,/^(issue (create|plan|bug)|release )/.test(path) ? {components:actions} : {}));
export const slackStateExamples:SlackExample[]=[
 card("failure","backoffice","❌ 요청 처리 실패","요청을 완료하지 못했습니다. 잠시 뒤 수집 상태를 확인하세요."),
 card("cancelled","backoffice","요청 취소 완료","아무 변경도 적용하지 않았습니다.",{components:[{type:1,components:actions![0].components.map(b=>({...b,disabled:true}))}]}),
 card("confirmed","backoffice","✅ 요청 접수 완료","실행 대기 중입니다. 결과가 도착하면 상태를 확인하세요."),
 card("weather","private-feed","오늘 날씨","기온 14°C, 비 올 확률 0%\n외출할 때 가벼운 겉옷을 준비하세요."),
];
export const slackExamples=[...slackDestinationExamples,...slackCommandExamples,...slackStateExamples];
