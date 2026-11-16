# Jam Browser · 백엔드 (중계 서버)

[Jam Browser](https://github.com/jam-browser/browser) 로 **멀리 있는 친구**와 함께하려고 할 때 쓰는 중계 서버예요.
같은 와이파이에서는 필요 없어요 (호스트 PC에 직접 접속).

- 중계 서버는 **길만 이어 줘요.** 진짜 Jam 서버는 호스트 PC 안에 있어요.
- 대화는 호스트와 참여자 사이에서 초대 코드의 비밀키로 **암호화**되어 있어서 중계 서버는 내용·이름을 볼 수 없어요.
- 아무것도 저장하지 않아요. 접속·종료 로그(시간, IP 앞부분)만 남아요.
- 가장 싼 사양(1 vCPU / 1GB RAM)으로 충분해요.
- **자동 업데이트**: 6시간마다 이 저장소의 릴리스를 확인하고, **배포 키로 서명된 버전만** 설치해요.

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
| 작업 `Jam Relay` | 부팅 때 시작, 계속 실행 (권한이 가장 낮은 LOCAL SERVICE 계정) |
| 작업 `Jam Relay Updater` | 6시간마다 + 부팅 10분 뒤 업데이트 확인 |
| 방화벽 규칙 | `Jam Relay (TCP 3031)` |

옵션: `-InstallDir D:\JamRelay` · `-Port 443` · `-Pfx C:\certs\relay.pfx -PfxPass 비밀번호` (wss) · `-NoAutoUpdate`

제거: `powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1 [-RemoveFiles]`

잠깐 시험만 해 보려면 `windows\start-relay.bat` 을 더블클릭하세요.

## 공유기 · 클라우드 설정

- **클라우드 서버(VPS)**: 업체 관리 화면의 보안 그룹/방화벽에서 **TCP 3031 인바운드** 허용
- **집 PC 를 서버로**: 공유기에서 **외부 TCP 3031 → 이 PC 의 내부 IP : 3031** 포트 포워딩. PC 의 내부 IP 는 고정해 두세요 (DHCP 예약)
- 앱에는 `서버주소:3031` 을 넣으면 돼요 (도메인이나 공인 IP)

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
npm test        # 중계 서버 7개 + 자동 업데이트 7개 (가짜 GitHub 서버로 서명 위조·변조·고장 난 버전·롤백 확인)
npm start       # 포트 3031
```

| 파일 | |
| --- | --- |
| `jam-relay.js` | 중계 서버 |
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
