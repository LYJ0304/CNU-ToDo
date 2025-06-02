# CNU-ToDo

충남대학교 학생을 위한 Todo 관리 시스템입니다. PWA(Progressive Web App)와 Chrome Extension, 서버로 구성되어 있습니다.

## 🏗️ 프로젝트 구조

```
CNUTodo/
├── pwa/                    # Progressive Web App
│   └── AutoDCS-PWA/       
├── chrome extension/       # 크롬 확장 프로그램
├── server/                # 백엔드 서버
└── README.md
```

## 🚀 설치 및 실행

### 1. 레포지토리 클론

```bash
git clone https://github.com/LYJ0304/CNU-ToDo.git
cd CNU-ToDo
```

### 2. 환경변수 설정

#### 서버 환경변수
프로젝트 루트에 `.env` 파일을 생성하고 다음 내용을 추가하세요:

```bash
cp env.example .env
```

`.env` 파일을 수정하여 실제 값들을 입력하세요:

```env
# 서버 설정
AUTODCS_PORT=9316
AUTODCS_KEY=your-actual-secret-key-here

# PWA 설정
PORT=8080

# 구글 애널리틱스 설정
GA_PROPERTY_ID=your-ga-property-id
GA_API_SECRET=your-ga-api-secret
GA_KEY_FILE_PATH=./pwa/AutoDCS-PWA/your-service-account-key.json

# 기타 설정
NODE_ENV=production
```

#### 구글 애널리틱스 설정 (PWA)
1. `pwa/AutoDCS-PWA/ga-config.example.json`을 복사하여 `ga-config.json`으로 생성
2. 실제 구글 애널리틱스 정보로 수정

```bash
cd pwa/AutoDCS-PWA
cp ga-config.example.json ga-config.json
```

### 3. 의존성 설치 및 실행

#### 서버 실행
```bash
cd server
npm install
npm start
```

#### PWA 실행
```bash
cd pwa/AutoDCS-PWA
npm install
npm start
```

## 📁 주요 파일 설명

- `server/main.js`: 백엔드 서버 메인 파일
- `pwa/AutoDCS-PWA/index.js`: PWA 메인 파일
- `pwa/AutoDCS-PWA/ga-server.js`: 구글 애널리틱스 연동
- `env.example`: 환경변수 설정 예시

## 🔐 보안 주의사항

**⚠️ 다음 파일들은 절대 깃허브에 업로드하지 마세요:**

- `.env` (환경변수 파일)
- `pwa/AutoDCS-PWA/ga-config.json` (구글 애널리틱스 설정)
- `pwa/AutoDCS-PWA/cnutodo-*.json` (구글 서비스 계정 키)
- `logs/`, `storage/`, `data/`, `cache/` 디렉토리들
- 기타 민감한 정보가 포함된 파일들

이러한 파일들은 `.gitignore`에 의해 자동으로 제외됩니다.

## 🛠️ 개발 환경

- Node.js
- Express.js
- Progressive Web App
- Google Analytics
- Chrome Extension

## 📝 라이선스

ISC

## 🤝 기여

충남대학교 학생들의 기여를 환영합니다!

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

**⚠️ 중요**: 이 프로젝트를 클론한 후 반드시 환경변수를 설정해야 정상적으로 작동합니다. 