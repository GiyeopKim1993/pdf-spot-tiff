# PDF → Spot TIFF

설치 프로그램과 백엔드 없이 브라우저에서 동작하는 정적 웹 페이지입니다.
HTML, CSS, JavaScript 및 저장소에 포함된 JavaScript PDF 라이브러리만 사용합니다.
PDF 업로드, API 호출, Photoshop 자동화, Ghostscript, Python, WebAssembly가 필요하지 않습니다.

## 기능

- PDF `Separation` / 별색 전용 `DeviceN`을 TIFF 별색 채널로 추출합니다.
- `White` 또는 `Spot`이 이름에 포함된 PDF OCG 레이어를 추출합니다(대소문자 구분 없음).
- 숨겨진 White/Spot 레이어도 추출합니다. 흰색 도형은 색상이 아닌 불투명도 마스크로 처리합니다.
- 동일 이름의 별색과 레이어는 한 채널로 합칩니다(픽셀별 최대 잉크 농도).
- 이름이 같은 여러 레이어도 한 채널로 합칩니다.
- 채널 이름과 한글을 보존합니다. 채널별 검정=잉크 100%, 흰색=잉크 0%입니다.
- 기본 RGB 이미지에서 해당 별색 및 레이어를 제외합니다.
- 원본 유지 / 72 / 150 / 300 / 600 / 1200 / 1440 DPI, 페이지 선택, 페이지별 다운로드를 지원합니다.
- 원본 유지는 각 페이지에 배치된 이미지의 픽셀 수와 실제 크기(회전/Form/UserUnit 포함)로 유효 DPI를 계산합니다. 여러 해상도는 가장 높은 DPI를 사용하고, 벡터/텍스트만 있으면 300 DPI로 저장하며 결과에 표시합니다. PDF 자체에는 일반적으로 단일 원본 DPI가 없습니다.

## GitHub Pages 배포

1. 이 저장소의 모든 정적 파일을 저장소에 올립니다.
2. GitHub 저장소의 **Settings → Pages → Deploy from a branch**를 선택합니다.
3. 배포할 브랜치와 **/ (root)**를 선택하고 저장합니다.
4. 표시되는 GitHub Pages 주소로 접속합니다.

빌드/Node.js/npm 설치는 배포와 실행에 필요하지 않습니다. 모든 경로가 상대 경로이므로
`https://사용자.github.io/저장소명/` 같은 프로젝트 Pages에서도 동작합니다.
라이브러리는 CDN이 아닌 저장소의 로컬 파일에서 읽습니다. 최초 페이지와 라이브러리 로딩 외에는
사용자의 PDF 데이터를 전송하지 않습니다.

로컬에서는 정적 HTTP 서버로 폴더를 제공하세요. 실행/배포에 빌드는 필요하지 않습니다.

## TIFF 형식과 Photoshop 호환성

8-bit RGB + 별색 샘플을 가진 classic TIFF를 JavaScript로 직접 작성합니다.
무손실 비압축, chunky layout, ExtraSamples=0(비지정 추가 샘플)을 사용합니다.
TIFF tag 34377에 Photoshop Image Resources를 기록합니다.

- 1006: Pascal 채널 이름
- 1045: UTF-16 채널 이름
- 1007 및 1077: DisplayInfo, 별색 모드 2, solidity 100%
- 1053: 채널 ID

기본 표시 색상은 White 계열=흰색, 그 외=마젠타입니다. 실제 인쇄 마스크/농도는 채널 데이터로
보존합니다. 원본 별색의 라이브러리/Pantone 표시 색상은 현재 보존하지 않습니다.

TIFF는 Adobe Photoshop 파일 형식 규격에 맞게 구성하며, 테스트는 파일 구조 및 브라우저
변환을 검증합니다. 실제 Photoshop 버전별 열기/별색 표시 검증은 별도로 필요합니다.

규격: [Adobe Photoshop File Formats](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/).

## 현재 지원 범위

기본 색상은 PDF.js의 RGB 렌더링 결과입니다. CMYK 수치 및 출력 ICC를 그대로 유지하는
인쇄용 색상 관리 변환은 지원하지 않습니다. Illustrator 편집 정보에만 저장된 레이어나
원본 Photoshop 채널은 PDF의 실제 `Separation`/`DeviceN` 또는 OCG로 존재해야 감지됩니다.

다음 구조는 잘못된 분판을 생성하지 않도록 오류로 중단합니다.

- CMYK와 별색이 혼합된 DeviceN
- 조건부 선택 콘텐츠(OCMD), 인라인 OCG 사전
- 인라인 이미지, Pattern 컬러
- 평면화되지 않은 PDF 주석/양식
- 암호화 PDF, 손상/과도한 중첩 콘텐츠

투명도 그룹, 소프트 마스크, 오버프린트 등 복잡한 인쇄 효과는 출력 RIP과 결과가 다를 수 있습니다.
단순 벡터/텍스트/일반 Image XObject 및 중첩 Form을 우선 지원합니다.
페이지 픽셀 수와 256MB/512MB 용량 제한은 없습니다. 타일 렌더링과 분할 TIFF 작성을 사용합니다.
실제 처리 가능한 크기는 브라우저/기기의 가용 메모리와 Classic TIFF의 4GB 형식 한도에 따릅니다. 최대 56개 별색 채널을 지원합니다.

## 검증

자동 테스트 18개 및 브라우저 픽셀 검증 17개 통과. 8,000 × 4,001픽셀 페이지의 91.6MB TIFF 생성 확인.
배포 버전은 폴더 구조를 평탄화하고 CMap/표준 폰트만 로컬 `font-data.json`에 묶었습니다.
모든 PDF 변환 코드는 읽고 수정할 수 있는 JavaScript 소스입니다.

## 포함 라이브러리

- pdf-lib 1.17.1: MIT, `pdf-lib.LICENSE.md`
- PDF.js 4.10.38: Apache-2.0, `pdfjs.LICENSE`
- PDF.js CMaps 및 표준 폰트: cmaps-LICENSE.txt 및 standard_fonts-LICENSE_*.txt 참고

배포 시 라이브러리와 라이선스 파일을 함께 유지하세요.

