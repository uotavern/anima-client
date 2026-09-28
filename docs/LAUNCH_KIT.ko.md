# Anima 검색 노출·공유 실행 자료

작성 및 채널 가이드 확인: 2026-09-11. 아래 소개문은 **게시 전 초안**입니다.
커뮤니티 게시, 개인 메시지, 이메일 발송은 이 작업에서 실행하지 않았습니다.

## 소개할 때 사용할 링크

- 영문 소개: https://www.uotavern.com/client/
- 한국어 소개: https://www.uotavern.com/client/ko/
- 사이트맵: https://www.uotavern.com/client/sitemap.xml
- 제품 저장소: https://github.com/hulryung-uo/anima-client
- 다운로드: https://github.com/hulryung-uo/anima-client/releases/latest
- 한국어 시작 안내: https://github.com/hulryung-uo/anima-client/blob/main/README.ko.md
- 설치 안내: https://github.com/hulryung-uo/anima-client/blob/main/docs/GETTING_STARTED.md
- AI 아키텍처: https://github.com/hulryung-uo/anima-client/blob/main/docs/DESIGN.md
- 실제 플레이 이미지: [문게이트](img/screenshot.png), [밤과 횃불](img/night.png)

## 누구에게 무엇을 보여줄지

| 대상 | 핵심 문장 | 보여줄 근거 | 원하는 다음 행동 |
|---|---|---|---|
| UO 플레이어 | 맥과 윈도우에서 플레이하는 새로운 UO 클라이언트 | 실제 월드 화면, 설치 파일 | 설치 후 접속 결과·버그 제보 |
| Rust·게임 개발자 | 네트워크 입출력과 분리된 sans-IO 게임 코어 | DESIGN.md, 코어 소스, 테스트 | 아키텍처 피드백·기여 |
| AI 에이전트 개발자 | 화면 인식 없이 관측값과 행동으로 UO 플레이 | JSON 계약, Python 에이전트 | 본인 에이전트 연결 |

사용할 검색 표현: `Ultima Online client for Mac`, `UO client macOS`,
`open source Ultima Online client`, `Rust Ultima Online client`,
`Ultima Online AI agent`, `울티마 온라인 맥 클라이언트`, `울티마 온라인 AI`.
각 표현은 해당 내용을 설명하는 문장에 자연스럽게 사용합니다.

## 한국어 개발자 커뮤니티 소개 초안

제목: **Anima — Rust로 만든 맥·윈도우용 울티마 온라인 클라이언트**

울티마 온라인 클라이언트 Anima를 만들고 있습니다. macOS와 Windows에서
사람이 플레이할 수 있고, 같은 Rust 코어에 AI 플레이어도 연결할 수 있는
오픈소스 프로젝트입니다.

핵심은 화면 없이 동작하는 `anima-core`입니다. UO 프로토콜, 월드 상태,
경로 탐색을 처리하고, 데스크톱 앱·브라우저 렌더러·AI 에이전트가 이를
공유합니다. 외부 에이전트는 패킷 대신 `Observation` / `Action` JSON으로
게임과 상호작용합니다.

현재 지형과 캐릭터 렌더링, 가방·상점·주문서·거래, 월드맵, 매크로,
밤과 횃불 조명 등을 구현했고 ServUO에서 실제 플레이를 검증했습니다.
v0.6.0에는 Apple Silicon용 macOS DMG와 Windows x64 설치 파일이 있습니다.
Mac 앱은 서명과 공증을 마쳤습니다.

UO 데이터와 서버 계정은 직접 준비해야 합니다. 모든 서버의 호환성을
보장하지는 않으며, 검증 범위는 저장소에 기록해 두었습니다.

설치·접속 결과나 Rust 구조에 대한 피드백을 받고 싶습니다.

소스와 다운로드: https://github.com/hulryung-uo/anima-client

**GeekNews에 올리는 경우:** 뉴스가 아닌 **Show** 유형으로, 실제 실행 가능한
저장소를 원문 URL로 사용합니다. 계정 가입 후 링크 등록까지 대기 조건이 있고,
같은 프로젝트의 반복 홍보는 피해야 합니다. [공식 이용 안내](https://news.hada.io/guidelines).

## 영문 UO 커뮤니티 소개 초안

Title: **Anima: an open-source Ultima Online client for Mac and Windows**

I'm building Anima, a from-scratch Ultima Online client in Rust. It has a
playable desktop app for Apple Silicon Macs and Windows x64, plus a headless
core for people experimenting with AI players.

The screenshots show real gameplay against a ServUO shard: terrain and animated
characters, paperdolls and containers, vendors and spellbooks, a world map,
macros, and night lighting with carried torches. The v0.6.0 Mac download is
signed and notarized.

You need your own UO game files and a shard account. Testing has focused on
ServUO, so I don't want to claim compatibility with every server. Check your
shard's client rules before trying it; the AI interface is optional.

If you try it, I'd appreciate a report of your OS, client version, server
software, and anything that didn't work. The code is MIT / Apache-2.0.

Source, screenshots, and downloads:
https://github.com/hulryung-uo/anima-client

**r/ultimaonline에 올리는 경우:** 기존 계정의 참여 이력과 현재 규칙을 확인합니다.
공식 가이드는 다른 UO 대화에도 참여할 것을 요구하고, 대략 일반 댓글 9개당
홍보 글 1개를 제시하며, 자기 콘텐츠 재게시를 금지합니다. 참여 이력이 확인되지
않은 계정으로 즉시 게시하지 않습니다. [커뮤니티 가이드](https://www.reddit.com/r/ultimaonline/wiki/spammingcontentcreation/).

## 개인 SNS용 짧은 문구

한국어:

> Rust로 울티마 온라인 클라이언트를 만들고 있습니다. 맥·윈도우에서 직접
> 플레이하고, 같은 코어에 AI도 연결합니다. Anima v0.6.0 설치 파일과 실제
> 플레이 화면을 공개했습니다. UO 데이터와 서버 계정은 별도입니다.
> https://github.com/hulryung-uo/anima-client

English:

> Anima: an open-source Ultima Online client in Rust. Play on Mac or Windows,
> or build an AI player on the same headless core. Bring your own UO data and
> shard account. https://github.com/hulryung-uo/anima-client

문게이트 또는 횃불 화면 한 장을 첨부합니다. 게시 플랫폼의 실제 글자 수 제한에
맞춰 줄이고, 개발자 본인의 작업임을 유지합니다.

## Hacker News에는 본인이 직접 쓸 것

HN의 현재 가이드는 AI 생성·AI 편집 텍스트 게시를 금지합니다. 위 초안을
HN에 복사하지 않습니다. 제작자가 자신의 말로 작성할 때 참고할 사실만 정리합니다.

- 네트워크 입출력과 분리된 sans-IO Rust 코어 (게임 클라이언트와 헤드리스 에이전트가 공유).
- 렌더러 바깥의 Observation / Action 계약과 교체 가능한 AI 브레인.
- 실제 실행 가능한 macOS / Windows 릴리스, UO 데이터 필요 조건.
- ServUO 검증 범위와 문서에 남긴 미검증 항목.
- 로그인 뒤 새 클라이언트에서 실제로 가능해진 플레이 사례.

Show HN에는 소개 사이트 대신 실행 가능한 저장소를 연결하고, 제작자가 직접
질문에 답할 수 있을 때 올립니다. [Show HN 안내](https://news.ycombinator.com/showhn.html),
[HN 가이드](https://news.ycombinator.com/newsguidelines.html).

## 30초 데모 영상 구성안

실제 플레이 녹화가 필요합니다. 기존 정지 이미지를 움직이는 플레이 영상으로
표현하지 않습니다. 녹화에는 계정 정보와 비공개 서버 주소를 노출하지 않습니다.

| 구간 | 실제 화면 | 자막 |
|---|---|---|
| 0–4초 | 캐릭터가 문게이트 주변을 걷는 장면 | Ultima Online. A new client. |
| 4–10초 | 가방·페이퍼돌·주문서 조작 | Play on macOS & Windows. |
| 10–17초 | 어두운 거리에서 횃불을 든 이동 | Bring a torch. |
| 17–24초 | 검증된 에이전트의 이동과 대응 관측값 | One Rust core. Human or AI. |
| 24–30초 | 다시 플레이 화면, 프로젝트 주소 | Anima · Open source · Download on GitHub |

에이전트 실연을 녹화할 수 없다면 그 구간은 월드맵·매크로 실연으로 바꿉니다.
서로 다른 시점을 한 장면인 것처럼 편집하거나 미구현 기능을 시연하지 않습니다.

## 검색 등록과 측정

공개 사이트의 canonical URL, robots.txt, sitemap.xml을 유지합니다.
Google Search Console에 URL-prefix 속성을 추가하고 제공받은 HTML 파일 또는
메타 태그로 소유권을 검증한 뒤 sitemap.xml을 제출합니다. 계정 소유자의 실제
검증 토큰이 필요하며, 임의 토큰으로 등록할 수 없습니다. 한국어 검색은
네이버 서치어드바이저에서도 소유 확인 후 사이트맵을 제출할 수 있습니다.

사이트맵은 URL 발견을 돕지만 검색 등록·순위를 보장하지 않습니다.
[Google 사이트맵 안내](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview),
[다국어 페이지 안내](https://developers.google.com/search/docs/specialty/international/localized-versions),
[네이버 서치어드바이저](https://searchadvisor.naver.com/guide/request-feed).

`python3 scripts/discovery-metrics.py`로 GitHub 공개 지표와 접근 가능한 트래픽
지표를 JSON으로 저장할 수 있습니다. 계정에 권한이 없으면 트래픽은 unavailable로
표시합니다. 트래픽·클론은 자동 수집을 포함할 수 있으며 설치자 수가 아닙니다.
다운로드는 릴리스 자산별 누적 요청 수로, 실제 실행이나 고유 사용자를 뜻하지 않습니다.
사이트 방문·공유 클릭은 현재 추적하지 않으며 UTM만 붙여도 자동 측정되지는 않습니다.

## 첫 2주 실행 순서

1. 공개 페이지와 GitHub 링크를 확인하고 첫 지표를 저장합니다.
2. 소유권 확인 후 검색 도구에 사이트맵을 제출합니다.
3. 본인이 활동하는 커뮤니티 한 곳에 소개하고 설치 피드백에 응답합니다.
4. 실제 30초 데모를 녹화하고 개인 SNS에 공유합니다.
5. 첫 피드백으로 설치 안내·호환성 문제를 개선합니다.
6. 7일·14일 뒤 다운로드 변화, 유효한 버그 제보, 검색 노출을 비교합니다.

성공 기준은 설치 성공 보고, 구체적인 호환성 피드백, 기여자 유입입니다.
바이럴·검색 순위·일정별 유입 수치는 실제 결과를 보고 판단합니다.
