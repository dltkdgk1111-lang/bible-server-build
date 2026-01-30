const { Plugin } = require('obsidian');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = class BiblePlugin extends Plugin {
    async onload() {
        console.log('Bible Plugin loading...');

        // 1. 서버 시작 전에 파일 변환 (txt -> exe) 시도
        this.renameTxtToExe();

        // 2. 서버 시작
        this.startServer();

        // 3. 상태바에 표시
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('Bible Server: Ready');
    }

    async onunload() {
        console.log('Bible Plugin unloading...');
        this.stopServer();
    }

    // ============================================================
    // [마법의 구간] .txt 파일을 발견하면 .exe로 이름 바꾸기
    // ============================================================
    renameTxtToExe() {
        // 현재 플러그인 폴더의 절대 경로 구하기
        // (Vault 경로 + .obsidian/plugins/ + 플러그인ID)
        const basePath = this.app.vault.adapter.basePath;
        const pluginPath = path.join(basePath, '.obsidian', 'plugins', this.manifest.id);

        const txtPath = path.join(pluginPath, 'bible-server-win.txt');
        const exePath = path.join(pluginPath, 'bible-server-win.exe');

        // 윈도우일 때만 실행
        if (process.platform === 'win32') {
            // txt 파일은 있는데, exe 파일이 아직 없다면? (처음 설치했을 때)
            if (fs.existsSync(txtPath) && !fs.existsSync(exePath)) {
                try {
                    console.log('Found .txt file, renaming to .exe...');
                    fs.renameSync(txtPath, exePath);
                    console.log('성공! bible-server-win.exe 생성 완료.');
                    
                    // (선택사항) 변환 후 잠시 대기 (파일 시스템 반영 시간 벌기)
                    // 동기 함수라 보통 필요 없지만 안전을 위해 로그만 남김
                } catch (err) {
                    console.error('파일 이름 변경 실패:', err);
                    // 실패해도 일단 서버 실행은 시도해봄 (이미 있을 수도 있으니까)
                }
            }
        }
    }
    // ============================================================

    startServer() {
        // 플러그인 폴더 경로 찾기
        const basePath = this.app.vault.adapter.basePath;
        const pluginDir = path.join(basePath, '.obsidian', 'plugins', this.manifest.id);

        let command = '';
        const args = [];

        // OS에 따라 실행할 파일 결정
        if (process.platform === 'win32') {
            command = path.join(pluginDir, 'bible-server-win.exe');
        } else if (process.platform === 'darwin') {
            command = path.join(pluginDir, 'bible-server-mac');
            
            // 맥/리눅스는 실행 권한이 필요할 수 있음 (chmod +x)
            try {
                if (fs.existsSync(command)) {
                    fs.chmodSync(command, '755');
                }
            } catch (err) {
                console.error('실행 권한 부여 실패:', err);
            }
        } else {
            console.log('Unsupported platform:', process.platform);
            return;
        }

        console.log(`Starting Bible Server at: ${command}`);

        // 파일이 실제로 있는지 확인
        if (!fs.existsSync(command)) {
            console.error(`Error: Server executable not found at ${command}`);
            this.statusBarItem.setText('Bible Server: Missing File');
            return;
        }

        // 서버 프로세스 실행 (cwd: 플러그인 폴더를 기준으로 실행해야 bible.json을 찾음)
        this.serverProcess = spawn(command, args, { cwd: pluginDir });

        // 로그 출력
        this.serverProcess.stdout.on('data', (data) => {
            console.log(`Server: ${data}`);
        });

        this.serverProcess.stderr.on('data', (data) => {
            console.error(`Server Error: ${data}`);
        });

        this.serverProcess.on('close', (code) => {
            console.log(`Bible server process exited with code ${code}`);
            this.statusBarItem.setText('Bible Server: Stopped');
        });

        this.statusBarItem.setText('Bible Server: Running');
    }

    stopServer() {
        if (this.serverProcess) {
            console.log('Killing Bible Server process...');
            this.serverProcess.kill();
            this.serverProcess = null;
            if (this.statusBarItem) {
                this.statusBarItem.setText('Bible Server: Off');
            }
        }
    }
};
