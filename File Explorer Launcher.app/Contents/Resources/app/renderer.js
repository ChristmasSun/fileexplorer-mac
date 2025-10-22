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
let undoStack = [];
let customQuickAccessItems = [];
let currentSortColumn = 'name';
let currentSortDirection = 'asc';
let fileIconCache = {};
let quickAccessOrder = [];
let recentOrder = [];
let thisPCOrder = [];
let drivesOrder = [];

async function init() {
  try {
    const homeDir = await ipcRenderer.invoke('get-home-directory');
    await loadCustomQuickAccess();
    await loadSidebarOrders();
    await navigateTo(homeDir, true);
    await loadQuickAccess();
    await loadRecentlyModified();
    await loadThisPC();
    await loadDrives();
    setupEventListeners();
  } catch (error) {
    console.error('Error during initialization:', error);
  }
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
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      performSearch(e.target.value);
    }, 300);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      showGlobalSearch(searchInput.value);
    }
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
    } else if (e.target.closest('.sidebar-item[data-custom="true"]')) {
      e.preventDefault();
      showSidebarContextMenu(e.pageX, e.pageY, e.target.closest('.sidebar-item'));
    }
  });

  document.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', handleContextMenuAction);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      if (!e.target.matches('input')) {
        copySelected();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      if (!e.target.matches('input')) {
        cutSelected();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      if (!e.target.matches('input')) {
        pasteItems();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      if (!e.target.matches('input')) {
        e.preventDefault();
        performUndo();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      showGlobalSearch('');
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      if (!e.target.matches('input')) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === 'F2') {
      renameSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      if (!e.target.matches('input')) {
        e.preventDefault();
        selectAll();
      }
    } else if (e.key === 'Escape') {
      const modal = document.getElementById('global-search-modal');
      if (modal.style.display !== 'none') {
        modal.style.display = 'none';
      }
    }
  });

  document.getElementById('close-search-modal').addEventListener('click', () => {
    document.getElementById('global-search-modal').style.display = 'none';
  });

  const globalSearchInput = document.getElementById('global-search-input');
  let globalSearchTimeout;
  globalSearchInput.addEventListener('input', (e) => {
    clearTimeout(globalSearchTimeout);
    globalSearchTimeout = setTimeout(() => {
      performGlobalSearch(e.target.value);
    }, 500);
  });

  document.getElementById('global-search-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('global-search-modal')) {
      document.getElementById('global-search-modal').style.display = 'none';
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
  await displayItems(items);
}

function sortItems(items) {
  return items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    let comparison = 0;

    if (currentSortColumn === 'name') {
      comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    } else if (currentSortColumn === 'modified') {
      comparison = new Date(a.modified) - new Date(b.modified);
    } else if (currentSortColumn === 'size') {
      comparison = a.size - b.size;
    }

    return currentSortDirection === 'asc' ? comparison : -comparison;
  });
}

async function displayItems(items) {
  const fileList = document.getElementById('file-list');
  fileList.innerHTML = '';

  if (currentView === 'details') {
    const header = document.createElement('div');
    header.className = 'file-list-header';

    const nameHeader = document.createElement('div');
    nameHeader.className = 'header-name';
    nameHeader.innerHTML = `Name ${getSortIndicator('name')}`;
    nameHeader.addEventListener('click', () => toggleSort('name'));

    const modifiedHeader = document.createElement('div');
    modifiedHeader.className = 'header-modified';
    modifiedHeader.innerHTML = `Date modified ${getSortIndicator('modified')}`;
    modifiedHeader.addEventListener('click', () => toggleSort('modified'));

    const sizeHeader = document.createElement('div');
    sizeHeader.className = 'header-size';
    sizeHeader.innerHTML = `Size ${getSortIndicator('size')}`;
    sizeHeader.addEventListener('click', () => toggleSort('size'));

    header.appendChild(nameHeader);
    header.appendChild(modifiedHeader);
    header.appendChild(sizeHeader);
    fileList.appendChild(header);
  }

  const sortedItems = sortItems(items);

  for (const item of sortedItems) {
    const itemElement = await createFileItem(item);
    fileList.appendChild(itemElement);
  }

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

function getSortIndicator(column) {
  if (currentSortColumn === column) {
    return `<span class="sort-indicator">${currentSortDirection === 'asc' ? '▲' : '▼'}</span>`;
  }
  return '';
}

function toggleSort(column) {
  if (currentSortColumn === column) {
    currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    currentSortColumn = column;
    currentSortDirection = 'asc';
  }
  loadDirectory();
}

async function createFileItem(item) {
  const itemElement = document.createElement('div');
  itemElement.className = 'file-item';
  itemElement.dataset.path = item.path;
  itemElement.dataset.isDirectory = item.isDirectory;
  itemElement.draggable = true;

  itemElement.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', item.path);
    e.dataTransfer.setData('application/x-file-path', item.path);
    e.dataTransfer.setData('application/x-is-directory', item.isDirectory);

    const draggedPaths = selectedItems.includes(item.path) ? selectedItems : [item.path];
    e.dataTransfer.setData('application/x-dragged-paths', JSON.stringify(draggedPaths));

    itemElement.classList.add('dragging');
  });

  itemElement.addEventListener('dragend', () => {
    itemElement.classList.remove('dragging');
  });

  if (item.isDirectory) {
    itemElement.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      itemElement.classList.add('drag-over');
    });

    itemElement.addEventListener('dragleave', () => {
      itemElement.classList.remove('drag-over');
    });

    itemElement.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      itemElement.classList.remove('drag-over');

      const draggedPathsJson = e.dataTransfer.getData('application/x-dragged-paths');
      if (draggedPathsJson) {
        const draggedPaths = JSON.parse(draggedPathsJson);
        await moveFilesToFolder(draggedPaths, item.path);
      }
    });
  }

  let iconElement;
  if (item.isDirectory) {
    iconElement = document.createElement('svg');
    iconElement.className = 'file-icon';
    iconElement.setAttribute('viewBox', '0 0 48 48');
    iconElement.innerHTML = `
      <path d="M6 10h16l4 6h16a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#FDB900"/>
      <path d="M6 16h36v22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V16z" fill="#FECF33"/>
    `;
  } else {
    if (fileIconCache[item.path]) {
      iconElement = document.createElement('img');
      iconElement.className = 'file-icon-image';
      iconElement.src = fileIconCache[item.path];
    } else {
      const iconData = await ipcRenderer.invoke('get-file-icon', item.path);
      if (iconData) {
        fileIconCache[item.path] = iconData;
        iconElement = document.createElement('img');
        iconElement.className = 'file-icon-image';
        iconElement.src = iconData;
      } else {
        iconElement = createGenericFileIcon(item.name);
      }
    }
  }

  const info = document.createElement('div');
  info.className = 'file-info';

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = item.name;
  if (item.isDirectory) {
    name.innerHTML += '<span class="file-type-badge">Folder</span>';
  }

  const modified = document.createElement('div');
  modified.className = 'file-modified';
  modified.textContent = formatDate(item.modified);

  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = item.isDirectory ? '' : formatFileSize(item.size);

  info.appendChild(name);
  info.appendChild(modified);
  info.appendChild(size);

  itemElement.appendChild(iconElement);
  itemElement.appendChild(info);

  itemElement.addEventListener('click', (e) => {
    handleItemClick(itemElement, e);
  });

  itemElement.addEventListener('dblclick', () => {
    handleItemDoubleClick(item);
  });

  return itemElement;
}

function createGenericFileIcon(fileName) {
  const icon = document.createElement('svg');
  icon.className = 'file-icon';
  icon.setAttribute('viewBox', '0 0 48 48');

  const ext = path.extname(fileName).toLowerCase();
  let color = '#fff';

  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico'].includes(ext)) {
    color = '#FF6B6B';
  } else if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'].includes(ext)) {
    color = '#9B59B6';
  } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'].includes(ext)) {
    color = '#3498DB';
  } else if (['.pdf'].includes(ext)) {
    color = '#E74C3C';
  } else if (['.doc', '.docx', '.txt', '.rtf', '.odt'].includes(ext)) {
    color = '#2980B9';
  } else if (['.xls', '.xlsx', '.csv', '.ods'].includes(ext)) {
    color = '#27AE60';
  } else if (['.ppt', '.pptx', '.key', '.odp'].includes(ext)) {
    color = '#E67E22';
  } else if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) {
    color = '#F39C12';
  } else if (['.js', '.ts', '.jsx', '.tsx', '.json'].includes(ext)) {
    color = '#F7DF1E';
  } else if (['.html', '.css', '.scss', '.sass'].includes(ext)) {
    color = '#E34C26';
  } else if (['.py', '.java', '.c', '.cpp', '.h', '.swift', '.go', '.rs'].includes(ext)) {
    color = '#3572A5';
  } else if (['.exe', '.app', '.dmg', '.pkg'].includes(ext)) {
    color = '#95A5A6';
  }

  icon.innerHTML = `
    <rect x="8" y="4" width="28" height="40" rx="2" fill="${color}" stroke="#ccc" stroke-width="1"/>
    <path d="M24 4v12h12" fill="#e0e0e0" stroke="#ccc" stroke-width="1"/>
    <rect x="12" y="22" width="20" height="2" fill="#f0f0f0"/>
    <rect x="12" y="28" width="20" height="2" fill="#f0f0f0"/>
    <rect x="12" y="34" width="15" height="2" fill="#f0f0f0"/>
  `;

  return icon;
}

function handleItemClick(itemElement, e) {
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
    clearSelection();
  }

  if (e.shiftKey && selectedItems.length > 0) {
    const allItems = Array.from(document.querySelectorAll('.file-item:not(.file-list-header)'));
    const lastSelected = allItems.find(item => item.classList.contains('selected'));
    if (lastSelected) {
      const lastSelectedIndex = allItems.indexOf(lastSelected);
      const currentIndex = allItems.indexOf(itemElement);
      const start = Math.min(lastSelectedIndex, currentIndex);
      const end = Math.max(lastSelectedIndex, currentIndex);

      for (let i = start; i <= end; i++) {
        allItems[i].classList.add('selected');
        if (!selectedItems.includes(allItems[i].dataset.path)) {
          selectedItems.push(allItems[i].dataset.path);
        }
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
  document.querySelectorAll('.file-item:not(.file-list-header)').forEach(item => {
    item.classList.add('selected');
    if (item.dataset.path) {
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
  loadRecentlyModified();
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
    addToUndoStack({
      type: 'create',
      path: result.path
    });
    await refresh();
  }
}

async function copySelected() {
  if (selectedItems.length > 0) {
    clipboard = [...selectedItems];
    clipboardOperation = 'copy';
    await ipcRenderer.invoke('copy-to-system-clipboard', selectedItems);
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

  const pasteOperations = [];

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
      pasteOperations.push({ type: 'copy', from: sourcePath, to: destPath });
    } else if (clipboardOperation === 'cut') {
      await ipcRenderer.invoke('move-item', sourcePath, destPath);
      pasteOperations.push({ type: 'move', from: sourcePath, to: destPath });
    }
  }

  addToUndoStack({
    type: 'paste',
    operations: pasteOperations
  });

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
  const oldName = path.basename(itemPath);

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
        addToUndoStack({
          type: 'rename',
          from: itemPath,
          to: result.newPath
        });
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
    const deletedItems = selectedItems.map(itemPath => ({
      path: itemPath
    }));

    for (const itemPath of selectedItems) {
      await ipcRenderer.invoke('delete-item', itemPath);
    }

    addToUndoStack({
      type: 'delete',
      items: deletedItems
    });

    await refresh();
    clearSelection();
  }
}

function addToUndoStack(operation) {
  undoStack.push(operation);
  if (undoStack.length > 20) {
    undoStack.shift();
  }
}

async function performUndo() {
  if (undoStack.length === 0) {
    console.log('Nothing to undo');
    return;
  }

  const operation = undoStack.pop();

  try {
    switch (operation.type) {
      case 'create':
        await ipcRenderer.invoke('delete-item', operation.path);
        break;

      case 'delete':
        alert('Cannot undo delete operations (files were permanently deleted)');
        break;

      case 'rename':
        await ipcRenderer.invoke('rename-item', operation.to, path.basename(operation.from));
        break;

      case 'move':
        await ipcRenderer.invoke('move-item', operation.to, operation.from);
        break;

      case 'paste':
        for (const op of operation.operations) {
          if (op.type === 'copy') {
            await ipcRenderer.invoke('delete-item', op.to);
          } else if (op.type === 'move') {
            await ipcRenderer.invoke('move-item', op.to, op.from);
          }
        }
        break;
    }

    await refresh();
  } catch (error) {
    console.error('Error performing undo:', error);
    alert('Failed to undo operation');
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
        if (action === 'unpin-quick-access') {
          const isPinned = customQuickAccessItems.some(qa => qa.path === selectedItems[0]);
          item.style.display = isPinned ? 'block' : 'none';
        } else if (action === 'pin-quick-access') {
          const isPinned = customQuickAccessItems.some(qa => qa.path === selectedItems[0]);
          item.style.display = isPinned ? 'none' : 'block';
        } else {
          item.style.display = 'block';
        }
      } else {
        item.style.display = ['open', 'rename', 'pin-quick-access', 'unpin-quick-access'].includes(action) ? 'none' : 'block';
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
      await copySelected();
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
    case 'pin-quick-access':
      await pinToQuickAccess();
      break;
    case 'unpin-quick-access':
      await unpinFromQuickAccess();
      break;
  }
}

async function pinToQuickAccess() {
  if (selectedItems.length !== 1) return;

  const itemPath = selectedItems[0];
  const items = await ipcRenderer.invoke('read-directory', currentPath);
  const item = items.find(i => i.path === itemPath);

  if (item && item.isDirectory) {
    if (!customQuickAccessItems.some(qa => qa.path === itemPath)) {
      customQuickAccessItems.push({
        name: item.name,
        path: itemPath
      });
      await ipcRenderer.invoke('save-quick-access', customQuickAccessItems);
      await loadQuickAccess();
    }
  }
}

async function unpinFromQuickAccess() {
  if (selectedItems.length !== 1) return;

  const itemPath = selectedItems[0];
  customQuickAccessItems = customQuickAccessItems.filter(qa => qa.path !== itemPath);
  await ipcRenderer.invoke('save-quick-access', customQuickAccessItems);
  await loadQuickAccess();
}

async function removeFromQuickAccess(itemPath) {
  customQuickAccessItems = customQuickAccessItems.filter(qa => qa.path !== itemPath);
  await ipcRenderer.invoke('save-quick-access', customQuickAccessItems);
  await loadQuickAccess();
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

async function showGlobalSearch(initialQuery = '') {
  const modal = document.getElementById('global-search-modal');
  const input = document.getElementById('global-search-input');
  modal.style.display = 'flex';
  input.value = initialQuery;
  input.focus();

  if (initialQuery.trim()) {
    await performGlobalSearch(initialQuery);
  } else {
    document.getElementById('global-search-results').innerHTML = '';
  }
}

async function performGlobalSearch(query) {
  const resultsContainer = document.getElementById('global-search-results');

  if (!query.trim()) {
    resultsContainer.innerHTML = '';
    return;
  }

  resultsContainer.innerHTML = '<div class="search-loading">Searching...</div>';

  const results = await ipcRenderer.invoke('search-files', query);

  if (results.length === 0) {
    resultsContainer.innerHTML = '<div class="search-empty">No files found</div>';
    return;
  }

  resultsContainer.innerHTML = '';

  for (const result of results) {
    const resultItem = document.createElement('div');
    resultItem.className = 'search-result-item';

    const icon = result.isDirectory ?
      createFolderIconSVG() :
      createGenericFileIcon(result.name);
    icon.className = 'search-result-icon';

    const info = document.createElement('div');
    info.className = 'search-result-info';

    const name = document.createElement('div');
    name.className = 'search-result-name';
    name.textContent = result.name;

    const pathDiv = document.createElement('div');
    pathDiv.className = 'search-result-path';
    pathDiv.textContent = result.path;

    info.appendChild(name);
    info.appendChild(pathDiv);

    resultItem.appendChild(icon);
    resultItem.appendChild(info);

    resultItem.addEventListener('click', async () => {
      if (result.isDirectory) {
        document.getElementById('global-search-modal').style.display = 'none';
        await navigateTo(result.path, true);
      } else {
        await navigateTo(path.dirname(result.path), true);
        document.getElementById('global-search-modal').style.display = 'none';
      }
    });

    resultsContainer.appendChild(resultItem);
  }
}

function createFolderIconSVG() {
  const icon = document.createElement('svg');
  icon.setAttribute('viewBox', '0 0 48 48');
  icon.innerHTML = `
    <path d="M6 10h16l4 6h16a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#FDB900"/>
    <path d="M6 16h36v22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V16z" fill="#FECF33"/>
  `;
  return icon;
}

async function loadCustomQuickAccess() {
  const saved = await ipcRenderer.invoke('load-quick-access');
  if (saved) {
    customQuickAccessItems = saved;
  }
}

async function loadQuickAccess() {
  const quickAccessList = document.getElementById('quick-access-list');
  quickAccessList.innerHTML = '';
  const homeDir = await ipcRenderer.invoke('get-home-directory');

  quickAccessList.addEventListener('dragover', (e) => {
    const isDirectory = e.dataTransfer.getData('application/x-is-directory') === 'true';
    const draggedPaths = e.dataTransfer.getData('application/x-dragged-paths');
    if (isDirectory || draggedPaths) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      quickAccessList.classList.add('drag-over');
    }
  });

  quickAccessList.addEventListener('dragleave', (e) => {
    if (!quickAccessList.contains(e.relatedTarget)) {
      quickAccessList.classList.remove('drag-over');
    }
  });

  quickAccessList.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    quickAccessList.classList.remove('drag-over');

    const draggedPathsJson = e.dataTransfer.getData('application/x-dragged-paths');
    if (draggedPathsJson) {
      const draggedPaths = JSON.parse(draggedPathsJson);
      for (const draggedPath of draggedPaths) {
        const items = await ipcRenderer.invoke('read-directory', currentPath);
        const item = items.find(i => i.path === draggedPath);
        if (item && item.isDirectory) {
          await pinFolderToQuickAccess(item);
        }
      }
    }
  });

  let quickAccessItems = [
    { name: 'Desktop', path: path.join(homeDir, 'Desktop') },
    { name: 'Documents', path: path.join(homeDir, 'Documents') },
    { name: 'Downloads', path: path.join(homeDir, 'Downloads') },
    { name: 'Pictures', path: path.join(homeDir, 'Pictures') },
    { name: 'Music', path: path.join(homeDir, 'Music') },
    { name: 'Videos', path: path.join(homeDir, 'Videos') }
  ];

  // Combine with custom items
  const allItems = [...quickAccessItems, ...customQuickAccessItems.map(item => ({ ...item, isCustom: true }))];

  // Apply saved order
  const orderedItems = applySavedOrder(allItems, quickAccessOrder);

  orderedItems.forEach(item => {
    const itemElement = createSidebarItem(item.name, item.path, getFolderIcon(), item.isCustom || false, 'quick-access');
    quickAccessList.appendChild(itemElement);
  });
}

async function loadRecentlyModified() {
  const recentList = document.getElementById('recent-list');
  recentList.innerHTML = '';

  let recentItems = await ipcRenderer.invoke('get-recently-modified', 10);

  // Apply saved order
  const orderedItems = applySavedOrder(recentItems, recentOrder);

  orderedItems.forEach(item => {
    const icon = item.isDirectory ? getFolderIcon() : getFileIcon();
    const itemElement = createSidebarItem(item.name, item.path, icon, false, 'recent');
    recentList.appendChild(itemElement);
  });

  if (recentItems.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '8px 12px';
    emptyMsg.style.fontSize = '11px';
    emptyMsg.style.color = '#999';
    emptyMsg.textContent = 'No recent files';
    recentList.appendChild(emptyMsg);
  }
}

async function loadThisPC() {
  const thisPCList = document.getElementById('thispc-list');
  thisPCList.innerHTML = '';
  const homeDir = await ipcRenderer.invoke('get-home-directory');

  let thisPCItems = [
    { name: 'Home', path: homeDir }
  ];

  // Apply saved order
  const orderedItems = applySavedOrder(thisPCItems, thisPCOrder);

  orderedItems.forEach(item => {
    const itemElement = createSidebarItem(item.name, item.path, getHomeIcon(), false, 'thispc');
    thisPCList.appendChild(itemElement);
  });
}

async function loadDrives() {
  const drivesList = document.getElementById('drives-list');
  drivesList.innerHTML = '';
  let drives = await ipcRenderer.invoke('get-drives');

  // Apply saved order
  const orderedItems = applySavedOrder(drives, drivesOrder);

  orderedItems.forEach(drive => {
    const itemElement = createSidebarItem(drive.name, drive.path, getDriveIcon(), false, 'drives');
    drivesList.appendChild(itemElement);
  });
}

function createSidebarItem(name, itemPath, iconSvg, isCustom = false, sectionType = null) {
  const item = document.createElement('div');
  item.className = 'sidebar-item';
  item.dataset.path = itemPath;
  item.dataset.sectionType = sectionType;

  // Make all sidebar items draggable for reordering within their section
  item.draggable = true;

  if (isCustom) {
    item.dataset.custom = 'true';
  }

  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', itemPath); // Fallback
    item.classList.add('dragging');

    // Store the dragged element globally so we can access it during dragover
    window.draggedSidebarItem = item;
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    window.draggedSidebarItem = null;

    // Clean up all drag-over classes
    document.querySelectorAll('.sidebar-item.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
  });

  item.addEventListener('dragover', (e) => {
    // Check if we're dragging a sidebar item
    if (!window.draggedSidebarItem) return;

    const draggedSection = window.draggedSidebarItem.dataset.sectionType;
    const currentSection = item.dataset.sectionType;

    // Only allow reordering within the same section
    if (draggedSection === currentSection && window.draggedSidebarItem !== item) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // Remove drag-over from all items first
      item.parentElement.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.remove('drag-over');
      });

      item.classList.add('drag-over');
    }
  });

  item.addEventListener('dragleave', (e) => {
    // Only remove if we're actually leaving the item (not entering a child)
    if (e.relatedTarget && !item.contains(e.relatedTarget)) {
      item.classList.remove('drag-over');
    }
  });

  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');

    if (!window.draggedSidebarItem) return;

    const draggedPath = window.draggedSidebarItem.dataset.path;
    const draggedSection = window.draggedSidebarItem.dataset.sectionType;

    if (draggedPath && draggedSection === item.dataset.sectionType && draggedPath !== itemPath) {
      await reorderSidebarItems(draggedPath, itemPath, draggedSection);
    }
  });

  item.addEventListener('dragover', (e) => {
    const hasFiles = e.dataTransfer.types.includes('application/x-dragged-paths');
    if (hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      item.classList.add('drag-over');
    }
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over');
  });

  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');

    const draggedPathsJson = e.dataTransfer.getData('application/x-dragged-paths');
    if (draggedPathsJson) {
      const draggedPaths = JSON.parse(draggedPathsJson);
      await moveFilesToFolder(draggedPaths, itemPath);
    }
  });

  const icon = document.createElement('div');
  icon.className = 'sidebar-item-icon';
  icon.innerHTML = iconSvg;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'sidebar-item-name';
  nameSpan.textContent = name;

  item.appendChild(icon);
  item.appendChild(nameSpan);

  if (isCustom) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from Quick access';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeFromQuickAccess(itemPath);
    });
    item.appendChild(removeBtn);
  }

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

function getFileIcon() {
  return `<svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2h5l3 3v9H4V2z"/>
    <path d="M9 2v3h3" fill="#fff"/>
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
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateObj = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  if (dateObj.getTime() === today.getTime()) {
    return `Today, ${timeStr}`;
  } else if (dateObj.getTime() === yesterday.getTime()) {
    return `Yesterday, ${timeStr}`;
  } else {
    return `${d.toLocaleDateString()} ${timeStr}`;
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

async function moveFilesToFolder(sourcePaths, destFolderPath) {
  for (const sourcePath of sourcePaths) {
    const fileName = path.basename(sourcePath);
    let destPath = path.join(destFolderPath, fileName);

    let counter = 1;
    const ext = path.extname(fileName);
    const nameWithoutExt = path.basename(fileName, ext);

    while (await ipcRenderer.invoke('check-path-exists', destPath)) {
      destPath = path.join(destFolderPath, `${nameWithoutExt} (${counter})${ext}`);
      counter++;
    }

    await ipcRenderer.invoke('move-item', sourcePath, destPath);
  }

  addToUndoStack({
    type: 'move',
    operations: sourcePaths.map((src, i) => ({
      from: src,
      to: path.join(destFolderPath, path.basename(sourcePaths[i]))
    }))
  });

  await refresh();
}

async function pinFolderToQuickAccess(item) {
  if (!customQuickAccessItems.some(qa => qa.path === item.path)) {
    customQuickAccessItems.push({
      name: item.name,
      path: item.path
    });
    await ipcRenderer.invoke('save-quick-access', customQuickAccessItems);
    await loadQuickAccess();
  }
}

async function reorderQuickAccess(draggedPath, targetPath) {
  const draggedIndex = customQuickAccessItems.findIndex(item => item.path === draggedPath);
  const targetIndex = customQuickAccessItems.findIndex(item => item.path === targetPath);

  if (draggedIndex !== -1 && targetIndex !== -1) {
    const [draggedItem] = customQuickAccessItems.splice(draggedIndex, 1);
    customQuickAccessItems.splice(targetIndex, 0, draggedItem);

    await ipcRenderer.invoke('save-quick-access', customQuickAccessItems);
    await loadQuickAccess();
  }
}

async function reorderSidebarItems(draggedPath, targetPath, sectionType) {
  // Get the current order array for this section
  let orderArray;
  let reloadFunction;

  switch (sectionType) {
    case 'quick-access':
      orderArray = quickAccessOrder;
      reloadFunction = loadQuickAccess;
      break;
    case 'recent':
      orderArray = recentOrder;
      reloadFunction = loadRecentlyModified;
      break;
    case 'thispc':
      orderArray = thisPCOrder;
      reloadFunction = loadThisPC;
      break;
    case 'drives':
      orderArray = drivesOrder;
      reloadFunction = loadDrives;
      break;
    default:
      return;
  }

  // Get current items in the DOM to determine the new order
  let sectionId;
  switch (sectionType) {
    case 'quick-access':
      sectionId = 'quick-access-list';
      break;
    case 'recent':
      sectionId = 'recent-list';
      break;
    case 'thispc':
      sectionId = 'thispc-list';
      break;
    case 'drives':
      sectionId = 'drives-list';
      break;
    default:
      return;
  }

  const sectionElement = document.getElementById(sectionId);
  if (!sectionElement) return;

  const allItems = Array.from(sectionElement.querySelectorAll('.sidebar-item'));
  const newOrder = allItems.map(item => item.dataset.path);

  // Update the dragged item position
  const draggedIndex = newOrder.indexOf(draggedPath);
  const targetIndex = newOrder.indexOf(targetPath);

  if (draggedIndex !== -1 && targetIndex !== -1) {
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedPath);
  }

  // Save the new order
  switch (sectionType) {
    case 'quick-access':
      quickAccessOrder = newOrder;
      break;
    case 'recent':
      recentOrder = newOrder;
      break;
    case 'thispc':
      thisPCOrder = newOrder;
      break;
    case 'drives':
      drivesOrder = newOrder;
      break;
  }

  await saveSidebarOrders();
  await reloadFunction();
}

function applySavedOrder(items, savedOrder) {
  if (!savedOrder || savedOrder.length === 0) {
    return items;
  }

  const orderedItems = [];
  const itemsMap = new Map(items.map(item => [item.path, item]));

  // Add items in saved order
  for (const path of savedOrder) {
    if (itemsMap.has(path)) {
      orderedItems.push(itemsMap.get(path));
      itemsMap.delete(path);
    }
  }

  // Add any new items that weren't in the saved order
  for (const item of itemsMap.values()) {
    orderedItems.push(item);
  }

  return orderedItems;
}

async function saveSidebarOrders() {
  const orders = {
    quickAccess: quickAccessOrder,
    recent: recentOrder,
    thisPC: thisPCOrder,
    drives: drivesOrder
  };
  await ipcRenderer.invoke('save-sidebar-orders', orders);
}

async function loadSidebarOrders() {
  const orders = await ipcRenderer.invoke('load-sidebar-orders');
  if (orders) {
    quickAccessOrder = orders.quickAccess || [];
    recentOrder = orders.recent || [];
    thisPCOrder = orders.thisPC || [];
    drivesOrder = orders.drives || [];
  }
}

init();
