const { ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

let currentPath = '';
let navigationHistory = [];
let historyIndex = -1;
let clipboard = null;
let clipboardOperation = null;
let selectedItems = [];
let currentView = 'details';

async function init() {
  const homeDir = await ipcRenderer.invoke('get-home-directory');
  await navigateTo(homeDir, true);
  await loadQuickAccess();
  await loadThisPC();
  await loadDrives();
  setupEventListeners();
}

function setupEventListeners() {
  document.getElementById('back-btn').addEventListener('click', navigateBack);
  document.getElementById('forward-btn').addEventListener('click', navigateForward);
  document.getElementById('up-btn').addEventListener('click', navigateUp);
  document.getElementById('refresh-btn').addEventListener('click', refresh);

  document.getElementById('new-folder-btn').addEventListener('click', createNewFolder);
  document.getElementById('cut-btn').addEventListener('click', cutSelected);
  document.getElementById('copy-btn').addEventListener('click', copySelected);
  document.getElementById('paste-btn').addEventListener('click', pasteItems);
  document.getElementById('rename-btn').addEventListener('click', renameSelected);
  document.getElementById('delete-btn').addEventListener('click', deleteSelected);

  document.getElementById('view-details-btn').addEventListener('click', () => setView('details'));
  document.getElementById('view-list-btn').addEventListener('click', () => setView('list'));
  document.getElementById('view-icons-btn').addEventListener('click', () => setView('icons'));

  const addressBar = document.querySelector('.address-bar');
  addressBar.addEventListener('click', (e) => {
    if (e.target === addressBar || e.target.classList.contains('breadcrumb')) {
      showAddressInput();
    }
  });

  const addressInput = document.getElementById('address-input');
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      navigateTo(addressInput.value, true);
      hideAddressInput();
    } else if (e.key === 'Escape') {
      hideAddressInput();
    }
  });

  addressInput.addEventListener('blur', () => {
    hideAddressInput();
  });

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => {
    performSearch(e.target.value);
  });

  document.addEventListener('click', (e) => {
    const contextMenu = document.getElementById('context-menu');
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = 'none';
    }
  });

  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.file-item')) {
      e.preventDefault();
      showContextMenu(e.pageX, e.pageY);
    } else if (e.target.closest('.file-list')) {
      e.preventDefault();
      showContextMenu(e.pageX, e.pageY, true);
    }
  });

  document.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', handleContextMenuAction);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      copySelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      cutSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      pasteItems();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!e.target.matches('input')) {
        deleteSelected();
      }
    } else if (e.key === 'F2') {
      renameSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      if (!e.target.matches('input')) {
        e.preventDefault();
        selectAll();
      }
    }
  });
}

async function navigateTo(dirPath, addToHistory = true) {
  const exists = await ipcRenderer.invoke('check-path-exists', dirPath);
  if (!exists) {
    return;
  }

  currentPath = dirPath;

  if (addToHistory) {
    navigationHistory = navigationHistory.slice(0, historyIndex + 1);
    navigationHistory.push(dirPath);
    historyIndex = navigationHistory.length - 1;
  }

  updateNavigationButtons();
  updateBreadcrumb();
  await loadDirectory();
  clearSelection();
  document.getElementById('search-input').value = '';
}

function updateNavigationButtons() {
  document.getElementById('back-btn').disabled = historyIndex <= 0;
  document.getElementById('forward-btn').disabled = historyIndex >= navigationHistory.length - 1;
  document.getElementById('up-btn').disabled = currentPath === '/' || currentPath === path.parse(currentPath).root;
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById('breadcrumb');
  breadcrumb.innerHTML = '';

  const parts = currentPath.split(path.sep).filter(p => p);

  if (currentPath.startsWith('/')) {
    const rootItem = createBreadcrumbItem('/', '/');
    breadcrumb.appendChild(rootItem);
  }

  let accumulatedPath = currentPath.startsWith('/') ? '/' : '';

  parts.forEach((part, index) => {
    if (index > 0 || currentPath.startsWith('/')) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.textContent = '›';
      breadcrumb.appendChild(separator);
    }

    accumulatedPath = path.join(accumulatedPath, part);
    const item = createBreadcrumbItem(part, accumulatedPath);
    breadcrumb.appendChild(item);
  });
}

function createBreadcrumbItem(label, itemPath) {
  const item = document.createElement('div');
  item.className = 'breadcrumb-item';
  item.textContent = label;
  item.addEventListener('click', () => {
    navigateTo(itemPath, true);
  });
  return item;
}

function showAddressInput() {
  const breadcrumb = document.getElementById('breadcrumb');
  const addressInput = document.getElementById('address-input');

  breadcrumb.style.display = 'none';
  addressInput.style.display = 'block';
  addressInput.value = currentPath;
  addressInput.focus();
  addressInput.select();
}

function hideAddressInput() {
  const breadcrumb = document.getElementById('breadcrumb');
  const addressInput = document.getElementById('address-input');

  breadcrumb.style.display = 'flex';
  addressInput.style.display = 'none';
}

async function loadDirectory() {
  const items = await ipcRenderer.invoke('read-directory', currentPath);
  displayItems(items);
}

function displayItems(items) {
  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';

  if (currentView === 'details') {
    const header = document.createElement('div');
    header.className = 'file-list-header';
    header.innerHTML = `
      <div class="header-name" style="padding-left: 30px;">Name</div>
      <div class="header-modified">Date modified</div>
      <div class="header-size">Size</div>
    `;
    fileList.appendChild(header);
  }

  const sortedItems = items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  sortedItems.forEach(item => {
    const itemElement = createFileItem(item);
    fileList.appendChild(itemElement);
  });

  if (items.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.innerHTML = `
      <svg class="empty-state-icon" viewBox="0 0 64 64">
        <path d="M8 12h20l4 6h24a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z" stroke="currentColor" fill="none" stroke-width="2"/>
      </svg>
      <div class="empty-state-text">This folder is empty</div>
    `;
    fileList.appendChild(emptyState);
  }
}

function createFileItem(item) {
  const itemElement = document.createElement('div');
  itemElement.className = 'file-item';
  itemElement.dataset.path = item.path;

  const icon = document.createElement('svg');
  icon.className = 'file-icon';
  icon.setAttribute('viewBox', '0 0 48 48');

  if (item.isDirectory) {
    icon.innerHTML = `
      <path d="M6 10h16l4 6h16a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#FDB900"/>
      <path d="M6 16h36v22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V16z" fill="#FECF33"/>
    `;
  } else {
    const ext = path.extname(item.name).toLowerCase();
    let color = '#fff';

    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'].includes(ext)) {
      color = '#FF6B6B';
    } else if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
      color = '#9B59B6';
    } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].includes(ext)) {
      color = '#3498DB';
    } else if (['.pdf'].includes(ext)) {
      color = '#E74C3C';
    } else if (['.doc', '.docx', '.txt', '.rtf'].includes(ext)) {
      color = '#2980B9';
    } else if (['.xls', '.xlsx', '.csv'].includes(ext)) {
      color = '#27AE60';
    } else if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
      color = '#F39C12';
    }

    icon.innerHTML = `
      <rect x="8" y="4" width="28" height="40" rx="2" fill="${color}" stroke="#ccc" stroke-width="1"/>
      <path d="M24 4v12h12" fill="#e0e0e0" stroke="#ccc" stroke-width="1"/>
      <rect x="12" y="22" width="20" height="2" fill="#f0f0f0"/>
      <rect x="12" y="28" width="20" height="2" fill="#f0f0f0"/>
      <rect x="12" y="34" width="15" height="2" fill="#f0f0f0"/>
    `;
  }

  const info = document.createElement('div');
  info.className = 'file-info';

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = item.name;

  const modified = document.createElement('div');
  modified.className = 'file-modified';
  modified.textContent = formatDate(item.modified);

  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = item.isDirectory ? '' : formatFileSize(item.size);

  info.appendChild(name);
  info.appendChild(modified);
  info.appendChild(size);

  itemElement.appendChild(icon);
  itemElement.appendChild(info);

  itemElement.addEventListener('click', (e) => {
    handleItemClick(itemElement, e);
  });

  itemElement.addEventListener('dblclick', () => {
    handleItemDoubleClick(item);
  });

  return itemElement;
}

function handleItemClick(itemElement, e) {
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
    clearSelection();
  }

  if (e.shiftKey && selectedItems.length > 0) {
    const allItems = Array.from(document.querySelectorAll('.file-item'));
    const lastSelectedIndex = allItems.indexOf(document.querySelector('.file-item.selected'));
    const currentIndex = allItems.indexOf(itemElement);
    const start = Math.min(lastSelectedIndex, currentIndex);
    const end = Math.max(lastSelectedIndex, currentIndex);

    for (let i = start; i <= end; i++) {
      allItems[i].classList.add('selected');
      if (!selectedItems.includes(allItems[i].dataset.path)) {
        selectedItems.push(allItems[i].dataset.path);
      }
    }
  } else {
    itemElement.classList.toggle('selected');

    const itemPath = itemElement.dataset.path;
    if (itemElement.classList.contains('selected')) {
      if (!selectedItems.includes(itemPath)) {
        selectedItems.push(itemPath);
      }
    } else {
      selectedItems = selectedItems.filter(p => p !== itemPath);
    }
  }
}

async function handleItemDoubleClick(item) {
  if (item.isDirectory) {
    await navigateTo(item.path, true);
  } else {
    await ipcRenderer.invoke('open-file', item.path);
  }
}

function clearSelection() {
  document.querySelectorAll('.file-item.selected').forEach(item => {
    item.classList.remove('selected');
  });
  selectedItems = [];
}

function selectAll() {
  clearSelection();
  document.querySelectorAll('.file-item').forEach(item => {
    if (!item.classList.contains('file-list-header')) {
      item.classList.add('selected');
      selectedItems.push(item.dataset.path);
    }
  });
}

function navigateBack() {
  if (historyIndex > 0) {
    historyIndex--;
    navigateTo(navigationHistory[historyIndex], false);
  }
}

function navigateForward() {
  if (historyIndex < navigationHistory.length - 1) {
    historyIndex++;
    navigateTo(navigationHistory[historyIndex], false);
  }
}

function navigateUp() {
  const parentPath = path.dirname(currentPath);
  if (parentPath !== currentPath) {
    navigateTo(parentPath, true);
  }
}

function refresh() {
  loadDirectory();
}

function setView(view) {
  currentView = view;
  const fileList = document.getElementById('file-list');
  fileList.className = `file-list view-${view}`;
  loadDirectory();
}

async function createNewFolder() {
  const folderName = 'New folder';
  let finalName = folderName;
  let counter = 1;

  while (await ipcRenderer.invoke('check-path-exists', path.join(currentPath, finalName))) {
    finalName = `${folderName} (${counter})`;
    counter++;
  }

  const result = await ipcRenderer.invoke('create-folder', currentPath, finalName);
  if (result.success) {
    await refresh();
  }
}

function copySelected() {
  if (selectedItems.length > 0) {
    clipboard = [...selectedItems];
    clipboardOperation = 'copy';
  }
}

function cutSelected() {
  if (selectedItems.length > 0) {
    clipboard = [...selectedItems];
    clipboardOperation = 'cut';
  }
}

async function pasteItems() {
  if (!clipboard || clipboard.length === 0) return;

  for (const sourcePath of clipboard) {
    const fileName = path.basename(sourcePath);
    let destPath = path.join(currentPath, fileName);

    if (sourcePath === destPath) {
      let counter = 1;
      const ext = path.extname(fileName);
      const nameWithoutExt = path.basename(fileName, ext);

      while (await ipcRenderer.invoke('check-path-exists', destPath)) {
        destPath = path.join(currentPath, `${nameWithoutExt} - Copy (${counter})${ext}`);
        counter++;
      }
    } else {
      let counter = 1;
      const ext = path.extname(fileName);
      const nameWithoutExt = path.basename(fileName, ext);

      while (await ipcRenderer.invoke('check-path-exists', destPath)) {
        destPath = path.join(currentPath, `${nameWithoutExt} (${counter})${ext}`);
        counter++;
      }
    }

    if (clipboardOperation === 'copy') {
      await ipcRenderer.invoke('copy-item', sourcePath, destPath);
    } else if (clipboardOperation === 'cut') {
      await ipcRenderer.invoke('move-item', sourcePath, destPath);
    }
  }

  if (clipboardOperation === 'cut') {
    clipboard = null;
    clipboardOperation = null;
  }

  await refresh();
}

async function renameSelected() {
  if (selectedItems.length !== 1) return;

  const itemPath = selectedItems[0];
  const itemElement = document.querySelector(`.file-item[data-path="${CSS.escape(itemPath)}"]`);

  if (!itemElement) return;

  const nameElement = itemElement.querySelector('.file-name');
  const oldName = nameElement.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = oldName;

  nameElement.textContent = '';
  nameElement.appendChild(input);
  input.focus();

  const ext = path.extname(oldName);
  if (ext) {
    input.setSelectionRange(0, oldName.length - ext.length);
  } else {
    input.select();
  }

  const finishRename = async (save) => {
    if (save && input.value && input.value !== oldName) {
      const result = await ipcRenderer.invoke('rename-item', itemPath, input.value);
      if (result.success) {
        await refresh();
        return;
      }
    }
    nameElement.textContent = oldName;
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishRename(true);
    } else if (e.key === 'Escape') {
      finishRename(false);
    }
  });

  input.addEventListener('blur', () => {
    finishRename(true);
  });
}

async function deleteSelected() {
  if (selectedItems.length === 0) return;

  const confirmMessage = selectedItems.length === 1
    ? `Are you sure you want to delete this item?`
    : `Are you sure you want to delete these ${selectedItems.length} items?`;

  if (confirm(confirmMessage)) {
    for (const itemPath of selectedItems) {
      await ipcRenderer.invoke('delete-item', itemPath);
    }
    await refresh();
    clearSelection();
  }
}

function showContextMenu(x, y, isEmpty = false) {
  const contextMenu = document.getElementById('context-menu');

  document.querySelectorAll('.context-menu-item').forEach(item => {
    const action = item.dataset.action;

    if (isEmpty) {
      item.style.display = ['paste'].includes(action) ? 'block' : 'none';
    } else {
      if (selectedItems.length === 0) {
        item.style.display = 'none';
      } else if (selectedItems.length === 1) {
        item.style.display = 'block';
      } else {
        item.style.display = ['open', 'rename'].includes(action) ? 'none' : 'block';
      }
    }
  });

  contextMenu.style.display = 'block';
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

async function handleContextMenuAction(e) {
  const action = e.target.dataset.action;
  const contextMenu = document.getElementById('context-menu');
  contextMenu.style.display = 'none';

  switch (action) {
    case 'open':
      if (selectedItems.length === 1) {
        const itemPath = selectedItems[0];
        const items = await ipcRenderer.invoke('read-directory', currentPath);
        const item = items.find(i => i.path === itemPath);
        if (item) {
          await handleItemDoubleClick(item);
        }
      }
      break;
    case 'cut':
      cutSelected();
      break;
    case 'copy':
      copySelected();
      break;
    case 'paste':
      await pasteItems();
      break;
    case 'rename':
      await renameSelected();
      break;
    case 'delete':
      await deleteSelected();
      break;
  }
}

async function performSearch(query) {
  if (!query.trim()) {
    await loadDirectory();
    return;
  }

  const items = await ipcRenderer.invoke('read-directory', currentPath);
  const filtered = items.filter(item =>
    item.name.toLowerCase().includes(query.toLowerCase())
  );
  displayItems(filtered);
}

async function loadQuickAccess() {
  const quickAccessList = document.getElementById('quick-access-list');
  const homeDir = await ipcRenderer.invoke('get-home-directory');

  const quickAccessItems = [
    { name: 'Desktop', path: path.join(homeDir, 'Desktop') },
    { name: 'Documents', path: path.join(homeDir, 'Documents') },
    { name: 'Downloads', path: path.join(homeDir, 'Downloads') },
    { name: 'Pictures', path: path.join(homeDir, 'Pictures') },
    { name: 'Music', path: path.join(homeDir, 'Music') },
    { name: 'Videos', path: path.join(homeDir, 'Videos') }
  ];

  quickAccessItems.forEach(item => {
    const itemElement = createSidebarItem(item.name, item.path, getFolderIcon());
    quickAccessList.appendChild(itemElement);
  });
}

async function loadThisPC() {
  const thisPCList = document.getElementById('thispc-list');
  const homeDir = await ipcRenderer.invoke('get-home-directory');

  const thisPCItems = [
    { name: 'Home', path: homeDir }
  ];

  thisPCItems.forEach(item => {
    const itemElement = createSidebarItem(item.name, item.path, getHomeIcon());
    thisPCList.appendChild(itemElement);
  });
}

async function loadDrives() {
  const drivesList = document.getElementById('drives-list');
  const drives = await ipcRenderer.invoke('get-drives');

  drives.forEach(drive => {
    const itemElement = createSidebarItem(drive.name, drive.path, getDriveIcon());
    drivesList.appendChild(itemElement);
  });
}

function createSidebarItem(name, itemPath, iconSvg) {
  const item = document.createElement('div');
  item.className = 'sidebar-item';
  item.dataset.path = itemPath;

  const icon = document.createElement('div');
  icon.className = 'sidebar-item-icon';
  icon.innerHTML = iconSvg;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'sidebar-item-name';
  nameSpan.textContent = name;

  item.appendChild(icon);
  item.appendChild(nameSpan);

  item.addEventListener('click', async () => {
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    await navigateTo(itemPath, true);
  });

  return item;
}

function getFolderIcon() {
  return `<svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 3h5l1 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
  </svg>`;
}

function getHomeIcon() {
  return `<svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 2l6 5v7H2V7z"/>
  </svg>`;
}

function getDriveIcon() {
  return `<svg viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="5" width="12" height="8" rx="1"/>
    <circle cx="5" cy="10" r="1"/>
    <circle cx="11" cy="10" r="1"/>
  </svg>`;
}

function formatDate(date) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateStr = d.toLocaleDateString();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (d.toDateString() === today.toDateString()) {
    return `Today ${timeStr}`;
  } else if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${timeStr}`;
  } else {
    return `${dateStr} ${timeStr}`;
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

init();
