/*
 * Totgo · Electron 主进程
 * 纯静态单机应用：不创建任何本地服务、不发起网络请求，
 * 直接用 file:// 加载同目录的 index.html，保证相对路径资源（CSS / JS / 字体）原样可用。
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    title: 'Totgo',
    // 窗口左上角 / 任务栏运行时图标；exe 文件图标由 build.win.icon 嵌入
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#F3F1EC',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 彻底移除默认菜单栏（File / Edit / View / Window / Help）
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
