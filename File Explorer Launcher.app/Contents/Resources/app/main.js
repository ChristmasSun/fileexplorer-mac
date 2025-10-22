const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#f3f3f3',
    titleBarStyle: 'default',
    frame: true,
    icon: path.join(__dirname, 'icon.icns')
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function calculateDirectorySize(dirPath, maxDepth = 2, currentDepth = 0) {
  let totalSize = 0;

  // Stop if we've gone too deep
  if (currentDepth >= maxDepth) {
    return 0;
  }

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      try {
        // Skip hidden files and certain system folders for speed
        if (item.name.startsWith('.')) continue;

        const fullPath = path.join(dirPath, item.name);
        const stats = fs.statSync(fullPath);

        if (item.isDirectory()) {
          // Only recurse one level deep
          totalSize += calculateDirectorySize(fullPath, maxDepth, currentDepth + 1);
        } else {
          totalSize += stats.size;
        }
      } catch (err) {
        // Skip files/folders we can't access
      }
    }
  } catch (err) {
    // Can't read directory
  }

  return totalSize;
}

ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return [];
    }

    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];

    for (const item of items) {
      try {
        const fullPath = path.join(dirPath, item.name);
        const itemStats = fs.statSync(fullPath);

        if (item.name.endsWith('.photoslibrary') || item.name.endsWith('.musiclibrary')) {
          continue;
        }

        let size = itemStats.size;

        // Calculate folder size if it's a directory (only 2 levels deep to avoid hanging)
        if (item.isDirectory()) {
          size = calculateDirectorySize(fullPath, 2, 0);
        }

        result.push({
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          size: size,
          modified: itemStats.mtime,
          created: itemStats.birthtime
        });
      } catch (err) {
      }
    }

    return result;
  } catch (error) {
    return [];
  }
});

ipcMain.handle('get-home-directory', () => {
  return os.homedir();
});

ipcMain.handle('get-drives', () => {
  const platform = process.platform;
  const drives = [];

  if (platform === 'darwin') {
    drives.push({
      name: 'Macintosh HD',
      path: '/',
      type: 'local'
    });

    try {
      const volumesPath = '/Volumes';
      if (fs.existsSync(volumesPath)) {
        const volumes = fs.readdirSync(volumesPath);
        volumes.forEach(volume => {
          const volumePath = path.join(volumesPath, volume);
          drives.push({
            name: volume,
            path: volumePath,
            type: 'removable'
          });
        });
      }
    } catch (err) {
      console.error('Error reading volumes:', err);
    }
  }

  return drives;
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-item', async (event, itemPath) => {
  try {
    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(itemPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-item', async (event, oldPath, newName) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    fs.renameSync(oldPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-folder', async (event, parentPath, folderName) => {
  try {
    const newPath = path.join(parentPath, folderName);
    fs.mkdirSync(newPath);
    return { success: true, path: newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('copy-item', async (event, sourcePath, destPath) => {
  try {
    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
      fs.cpSync(sourcePath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-item', async (event, sourcePath, destPath) => {
  try {
    fs.renameSync(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-item-stats', async (event, itemPath) => {
  try {
    const stats = fs.statSync(itemPath);
    return {
      success: true,
      stats: {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isDirectory: stats.isDirectory()
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-path-exists', async (event, checkPath) => {
  return fs.existsSync(checkPath);
});

ipcMain.handle('get-file-icon', async (event, filePath) => {
  try {
    const icon = await app.getFileIcon(filePath, { size: 'normal' });
    return icon.toDataURL();
  } catch (error) {
    return null;
  }
});

ipcMain.handle('copy-to-system-clipboard', async (event, paths) => {
  try {
    if (process.platform === 'darwin') {
      clipboard.writeBuffer('public.file-url', Buffer.from(paths.map(p => `file://${p}`).join('\n')));
    } else {
      const pathsString = paths.join('\n');
      clipboard.writeText(pathsString);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recently-modified', async (event, limit = 20) => {
  try {
    const homeDir = os.homedir();
    const searchDirs = [
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Documents'),
      path.join(homeDir, 'Downloads'),
      path.join(homeDir, 'Pictures'),
      path.join(homeDir, 'Music'),
      path.join(homeDir, 'Videos')
    ];

    const allFiles = [];

    function scanDirectory(dirPath, depth = 0) {
      if (depth > 2) return;

      try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const item of items) {
          try {
            if (item.name.startsWith('.')) continue;

            const fullPath = path.join(dirPath, item.name);
            const stats = fs.statSync(fullPath);

            allFiles.push({
              name: item.name,
              path: fullPath,
              isDirectory: item.isDirectory(),
              modified: stats.mtime,
              size: stats.size
            });

            if (item.isDirectory() && depth < 2) {
              scanDirectory(fullPath, depth + 1);
            }
          } catch (err) {
          }
        }
      } catch (err) {
      }
    }

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        scanDirectory(dir);
      }
    }

    allFiles.sort((a, b) => b.modified - a.modified);

    return allFiles.slice(0, limit);
  } catch (error) {
    console.error('Error getting recently modified:', error);
    return [];
  }
});

ipcMain.handle('search-files', async (event, query, searchPath = null) => {
  return new Promise((resolve) => {
    const results = [];
    const maxResults = 100;

    if (!query || query.trim().length === 0) {
      resolve([]);
      return;
    }

    const searchDir = searchPath || os.homedir();
    const searchQuery = query.toLowerCase();

    function searchDirectory(dirPath, depth = 0) {
      if (depth > 3 || results.length >= maxResults) return;

      try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const item of items) {
          if (results.length >= maxResults) break;

          try {
            if (item.name.startsWith('.')) continue;

            if (item.name.toLowerCase().includes(searchQuery)) {
              const fullPath = path.join(dirPath, item.name);
              const stats = fs.statSync(fullPath);

              results.push({
                name: item.name,
                path: fullPath,
                isDirectory: item.isDirectory(),
                modified: stats.mtime,
                size: stats.size
              });
            }

            if (item.isDirectory() && depth < 3) {
              const fullPath = path.join(dirPath, item.name);
              searchDirectory(fullPath, depth + 1);
            }
          } catch (err) {
          }
        }
      } catch (err) {
      }
    }

    searchDirectory(searchDir);

    setTimeout(() => {
      resolve(results);
    }, 100);
  });
});

ipcMain.handle('save-quick-access', async (event, items) => {
  try {
    const configPath = path.join(app.getPath('userData'), 'quick-access.json');
    fs.writeFileSync(configPath, JSON.stringify(items, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-quick-access', async () => {
  try {
    const configPath = path.join(app.getPath('userData'), 'quick-access.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    return null;
  }
});

ipcMain.handle('save-sidebar-orders', async (event, orders) => {
  try {
    const configPath = path.join(app.getPath('userData'), 'sidebar-orders.json');
    fs.writeFileSync(configPath, JSON.stringify(orders, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-sidebar-orders', async () => {
  try {
    const configPath = path.join(app.getPath('userData'), 'sidebar-orders.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    return null;
  }
});
