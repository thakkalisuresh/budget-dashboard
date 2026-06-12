/**
 * Google Drive utilities for serverless functions.
 * Handles: refresh-token exchange, folder creation, file upload, sharing.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */

const DRIVE_API   = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL   = 'https://oauth2.googleapis.com/token';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

let tokenCache = null;

export async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Drive credentials not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Token refresh failed: ${err.error_description || res.status}`);
  }
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.token;
}

async function driveRequest(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Drive API error (${res.status}): ${err.error?.message || JSON.stringify(err)}`);
  }
  return res.json();
}

export async function findOrCreateFolder(name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false` +
            (parentId ? ` and '${parentId}' in parents` : '');
  const search = await driveRequest(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);

  if (search.files && search.files.length > 0) {
    return search.files[0].id;
  }

  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];

  const folder = await driveRequest(DRIVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return folder.id;
}

export async function buildFolderPath(year, month, category) {
  const rootId     = await findOrCreateFolder('Receipts', null);
  const yearId     = await findOrCreateFolder(String(year), rootId);
  const monthId    = await findOrCreateFolder(month, yearId);
  if (!category) return { folderId: monthId };
  const categoryId = await findOrCreateFolder(category, monthId);
  return { folderId: categoryId };
}

export async function uploadFile(folderId, fileName, mimeType, base64Data) {
  const token = await getAccessToken();
  const boundary = '----ReceiptUpload' + Date.now();
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  const binaryData = Buffer.from(base64Data, 'base64');

  const multipartBody = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    metadata + '\r\n',
    `--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n`,
    'Content-Transfer-Encoding: base64\r\n\r\n',
    base64Data + '\r\n',
    `--${boundary}--`,
  ].join('');

  const res = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Upload failed (${res.status}): ${err.error?.message || 'unknown'}`);
  }
  return res.json();
}

export async function setAnyoneWithLinkPermission(fileId) {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'anyone', role: 'reader' }),
  });
  if (!res.ok) {
    console.warn(`Drive permission set failed for ${fileId}: ${res.status}`);
  }
}

export async function moveFile(fileId, newFolderId) {
  const token = await getAccessToken();
  const fileRes = await fetch(`${DRIVE_API}/${fileId}?fields=parents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) throw new Error(`Failed to get file parents: ${fileRes.status}`);
  const { parents } = await fileRes.json();
  const oldParents = (parents || []).join(',');

  const moveRes = await fetch(
    `${DRIVE_API}/${fileId}?addParents=${newFolderId}&removeParents=${oldParents}&fields=id,parents`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!moveRes.ok) throw new Error(`Failed to move file: ${moveRes.status}`);
  return moveRes.json();
}

export async function copyFile(fileId, newName) {
  return driveRequest(`${DRIVE_API}/${fileId}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
}

export async function shareWithEmails(fileId, emails) {
  const valid = emails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  await Promise.allSettled(
    valid.map(email =>
      driveRequest(`${DRIVE_API}/${fileId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
      })
    )
  );
}

export async function uploadReceiptImage({ year, month, category, fileName, mimeType, base64 }) {
  const { folderId } = await buildFolderPath(year, month, category);
  const file = await uploadFile(folderId, fileName, mimeType, base64);
  await setAnyoneWithLinkPermission(file.id);
  return {
    fileId: file.id,
    folderId,
    shareLink: file.webViewLink,
  };
}
