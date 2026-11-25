# Jam Browser · 백엔드 (중계 서버)

[Jam Browser](https://github.com/jam-browser/browser) 로 **멀리 있는 친구**와 함께하려고 할 때 쓰는 중계 서버예요.
같은 와이파이에서는 필요 없어요 (호스트 PC에 직접 접속).

- 중계 서버는 **길만 이어 줘요.** 진짜 Jam 서버는 호스트 PC 안에 있어요.
- 대화는 호스트와 참여자 사이에서 초대 코드의 비밀키로 **암호화**되어 있어서 중계 서버는 내용·이름을 볼 수 없어요.
- Jam 내용은 아무것도 저장하지 않아요. 접속·종료 로그(시간, IP 앞부분)만 남아요.
- **브라우저 계정**(아이디 + 비밀번호 로그인, 기기 사이 동기화)을 쓰면 계정 정보만 서버에 저장돼요 — 아래 [브라우저 계정](#브라우저-계정) 참고.
- 가장 싼 사양(1 vCPU / 1GB RAM)으로 충분해요.
- **자동 업데이트**: 5분마다 이 저장소의 릴리스를 확인하고, **배포 키로 서명된 버전만** 설치해요.

```
참여자 ──인터넷──▶ 중계 서버 ──▶ 호스트 PC (Jam Browser 안의 Jam 서버)
                 (암호화된 데이터를 그대로 전달)
```

## 포트

| 포트 | 방향 | 용도 |
| --- | --- | --- |
| **TCP 3031** | 들어오는 연결 | 중계 서버 (설치 때 `-Port` 로 바꿀 수 있음, TLS 를 쓰면 보통 443) |
| TCP 443 | 나가는 연결 | 자동 업데이트 확인 (github.com) — 따로 열 필요 없음 |

UDP 는 쓰지 않아요.

## Windows 서버에 설치 (권장)

1. Node.js LTS 설치: `winget install OpenJS.NodeJS.LTS`
2. [Releases](https://github.com/jam-browser/backend/releases/latest) 에서 `jam-relay-<버전>.zip` 을 받아 압축 풀기
3. **관리자 PowerShell** 에서:

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1
```

설치되는 것:

| | |
| --- | --- |
| `C:\JamRelay\versions\<버전>\` | 프로그램 (버전별 폴더, 이전 버전 하나는 되돌리기용으로 보관) |
| `C:\JamRelay\config.json` | 포트 · 인증서 · 자동 업데이트 설정 |
| `C:\JamRelay\logs\` | relay.log, updater.log |
| `C:\JamRelay\data\` | 브라우저 계정 데이터 (처음 쓸 때 생김, **백업 필요** · 제거할 때 `-RemoveFiles` 를 주면 같이 지워짐) |
| 작업 `Jam Relay` | 부팅 때 시작, 계속 실행 (권한이 가장 낮은 LOCAL SERVICE 계정) |
| 작업 `Jam Relay Updater` | 5분마다 + 부팅 2분 뒤 업데이트 확인 |
| 방화벽 규칙 | `Jam Relay (TCP 3031)` |

옵션: `-InstallDir D:\JamRelay` · `-Port 443` · `-Pfx C:\certs\relay.pfx -PfxPass 비밀번호` (wss) · `-UpdateEveryMinutes 60` (기본 5분) · `-NoAutoUpdate`

제거: `powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1 [-RemoveFiles]`

잠깐 시험만 해 보려면 `windows\start-relay.bat` 을 더블클릭하세요.

## 공유기 · 클라우드 설정

- **클라우드 서버(VPS)**: 업체 관리 화면의 보안 그룹/방화벽에서 **TCP 3031 인바운드** 허용
- **집 PC 를 서버로**: 공유기에서 **외부 TCP 3031 → 이 PC 의 내부 IP : 3031** 포트 포워딩. PC 의 내부 IP 는 고정해 두세요 (DHCP 예약)
- 앱에는 `서버주소:3031` 을 넣으면 돼요 (도메인이나 공인 IP)

## 브라우저 계정

Jam Browser 의 **서버 계정**(아이디 + 비밀번호)으로 로그인하면, 같은 계정의 다른 기기에서 보관함을 받아 동기화할 수 있어요.
보관함은 앱이 **미리 암호화**해서 올리기 때문에 서버(와 서버 주인)는 내용을 볼 수 없어요.

**서버가 저장하는 것**

| | |
| --- | --- |
| 아이디 | 영문 소문자 · 숫자 · `. _ -`, 3~32자 |
| 암호화된 보관함 | 서버는 열 수 없어요. 형식만 확인하고 그대로 보관 (계정당 최대 5MB) |
| 로그인 확인 값 | 앱이 비밀번호에서 만든 값을 서버가 한 번 더 scrypt 한 것. **비밀번호 자체는 서버에 오지도, 저장되지도 않아요** |

로그인 토큰은 메모리에만 있어서 서버를 다시 켜면 앱이 다시 로그인해요.
비밀번호를 잊으면 서버 주인도 보관함을 되살릴 수 없어요 (서버에는 열쇠가 없음).

**가입 정책** — `config.json` 의 `"signup"` (또는 환경 변수 `JAM_RELAY_SIGNUP`)

| 값 | |
| --- | --- |
| `invite` (기본) | 초대 코드가 있어야 가입 |
| `open` | 누구나 가입 (IP 마다 1시간에 5개까지) |
| `closed` | 새 가입을 막음 (이미 있는 계정은 그대로 사용) |

초대 코드 만들기 (서버 PC 의 관리자 PowerShell, 서버를 다시 켤 필요 없음):

```powershell
cd C:\JamRelay
$v = Get-Content current.txt
node "versions\$v\jam-relay.js" --invite --home C:\JamRelay                       # 1번 쓸 수 있고 7일 동안 유효
node "versions\$v\jam-relay.js" --invite --uses 5 --days 30 --home C:\JamRelay    # 5번, 30일
node "versions\$v\jam-relay.js" --invites --home C:\JamRelay                      # 쓸 수 있는 코드 목록
```

`JINV-XXXX-XXXX-XXXX` 모양의 코드가 나와요. 서버에는 코드의 해시만 저장되니, 나온 코드를 바로 친구에게 전해 주세요.

**데이터 폴더** — 설치형은 `C:\JamRelay\data\` (`--home` 없이 실행하면 실행한 폴더의 `data\`, `config.json` 의 `"dataDir"` 또는 `JAM_RELAY_DATA` 로 바꿀 수 있음)

| | |
| --- | --- |
| `accounts\` | 계정마다 파일 하나 (암호화된 보관함 + 로그인 확인 값) |
| `invites.json` | 초대 코드 해시 · 남은 횟수 · 기한 |
| `secret.bin` | 서버 비밀값 (없는 아이디에도 그럴듯한 응답을 주는 데 씀) |

- 이 폴더는 **꼭 백업**하세요. 잃어버리면 서버의 계정과 보관함이 모두 사라져요 (각 기기에 남은 사본은 그대로).
- 인터넷에 열어 둔다면 **TLS(wss / https)를 강력히 권장**해요 (설치 때 `-Pfx`, 또는 config 의 `pfx` / `cert` · `key`).
  보관함은 암호화돼 있지만, TLS 가 없으면 로그인 값과 토큰이 그대로 오가서 중간에서 엿본 사람이 그 계정으로 로그인하거나 보관함을 지울 수 있어요.
- 웹페이지(http/https 출처)에서는 계정 API 를 부를 수 없어요. 비밀번호를 계속 틀리면 그 아이디는 잠시 잠기고(최대 60분), 한 IP 에서 실패가 많으면 10분 동안 막혀요.
- 앞에 리버스 프록시를 두면 모든 요청이 프록시 IP 로 보여서 IP 별 제한이 다 같이 걸려요 (`X-Forwarded-For` 는 믿지 않음).

## 친구 상태 (1.2.0+)

Jam Browser 의 👥 친구 창(온라인 · 자리 비움 · 보는 사이트)을 위해 `POST /friends/put` · `POST /friends/get` 으로
`{ 무작위 ID → 암호문 }` 을 **메모리에만 3분** 맡아요 (앱이 1분마다 다시 올림 → 안 올리면 사라져서 오프라인).

- ID 와 암호 키는 친구 **둘의 신원 키**에서 나와요 (X25519). 서버는 누가 누구 친구인지, 온라인인지, 무슨 사이트인지 몰라요. ID 는 1시간마다 바뀌어요
- 디스크에 아무것도 저장하지 않아요. `/status` 의 `friendStatus` 는 지금 맡고 있는 수
- 한도: 요청당 올리기 256개 · 찾기 512개, 암호문 1KB, IP 마다 1분에 60번 · 1024개, 전체 10만 개. 웹페이지(Origin)는 403
- 서버가 알 수 있는 것: 어떤 IP 가 몇 개를 올리고 찾는지 (같은 ID 를 올린 IP 와 찾은 IP 를 이어 보면 "이 둘이 친구일 수 있다" 정도). 내용은 모름

## 자동 업데이트는 이렇게 동작해요

1. `Jam Relay Updater` 가 GitHub 의 최신 릴리스를 확인
2. 새 버전이면 `jam-relay-<버전>.zip` + `.sig` 를 받음
3. **지금 설치된 버전에 들어 있는 공개키**(`release-key.pub.pem`)로 서명 확인 — 서명이 다르거나 파일이 바뀌었으면 설치 안 함
   → GitHub 계정이 털려도, 배포 비밀키가 없으면 서버에 가짜 업데이트를 넣을 수 없어요
4. 새 버전을 다른 포트로 잠깐 띄워 응답하는지 **자체 점검**
5. `current.txt` 를 새 버전으로 바꿈 → 진행 중인 Jam 이 없을 때 중계 서버가 스스로 재시작하며 새 버전으로 바뀜 (Jam 중에는 끊지 않음, 6시간 넘게 계속 바쁘면 교체)
6. 새 버전이 응답하지 않으면 **이전 버전으로 되돌리고** 그 버전은 다시 시도하지 않음

로그: `C:\JamRelay\logs\updater.log` · 끄기: `config.json` 의 `"autoUpdate": false`

## 릴리스 하기 (배포하는 사람)

```bash
npm version patch                         # 버전 올리기
node tools/make-release.js --key <비밀키.pem> --publish
```

- 비밀키는 저장소 밖에 보관하고 꼭 백업하세요. 잃어버리면 이미 설치된 서버에 업데이트를 보낼 수 없어요 (서버에서 재설치 필요).
- 처음 한 번 키 만들기: `node tools/keygen.js --out <비밀키 경로>` (공개키는 `release-key.pub.pem` 에 저장됨)

## 개발

```bash
npm ci
npm test        # 중계 서버 · 브라우저 계정 · 자동 업데이트 (가짜 GitHub 서버로 서명 위조·변조·고장 난 버전·롤백 확인)
npm start       # 포트 3031
```

| 파일 | |
| --- | --- |
| `jam-relay.js` | 중계 서버 |
| `accounts.js` | 브라우저 계정 (로그인 · 암호화된 보관함 동기화 · 초대 코드) |
| `updater.js` | 자동 업데이트 |
| `release-sign.js` | 릴리스 서명 규칙 (Ed25519, "jam-relay\|버전\|SHA-256") |
| `release-key.pub.pem` | 업데이트 확인용 공개키 |
| `windows/` | 설치 · 실행 · 제거 스크립트 |
| `tools/` | 릴리스 만들기 · 키 만들기 |

## 운영 메모

- 웹페이지(http/https 출처)는 접속할 수 없어요. Jam Browser 앱만 접속돼요.
- 한 Jam 최대 16명, IP 당 동시 연결 30개, 메시지 크기·속도 제한
- 잘못된 초대 코드를 계속 넣는 사람은 **호스트 PC 쪽**에서 손님 IP 별로 차단돼요
- 친구끼리 무료로 쓰면 보통 문제없지만, 불특정 다수에게 서비스로 열거나 돈을 받는다면 전기통신사업법상 부가통신사업 신고 대상인지 확인하세요.

[MIT 라이선스](LICENSE) · 문서: [jam-browser/docs](https://github.com/jam-browser/docs)
