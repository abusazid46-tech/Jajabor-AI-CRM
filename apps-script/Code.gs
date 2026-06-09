const CONFIG = {
  sheets: {
    leads: 'Leads',
    users: 'Users'
  },
  roles: {
    admin: 'admin',
    agent: 'agent'
  },
  tokenTtlMs: 8 * 60 * 60 * 1000,
  maxPageSize: 500,
  leadHeaders: [
    'Lead ID',
    'Name',
    'Phone',
    'Source',
    'Date Added',
    'Status',
    'Priority',
    'Assigned To',
    'Last Call Date',
    'Next Follow-up Date',
    'Remarks',
    'Created By',
    'Last Updated'
  ],
  userHeaders: [
    'Username',
    'Name',
    'Role',
    'Password Hash',
    'Salt',
    'Active'
  ],
  statuses: ['New', 'Contacted', 'Interested', 'Not Interested', 'Callback Later', 'Closed'],
  priorities: ['Hot', 'Warm', 'Cold'],
  sources: ['Manual', 'Facebook Ads', 'Google Ads', 'Website']
};

function doPost(event) {
  try {
    const request = parseRequest(event);
    const action = String(request.action || '').trim();

    if (action === 'authenticate') {
      return jsonResponse(authenticate(request));
    }

    const user = verifyToken(request.token);
    const routes = {
      getOptions: () => getOptions(user),
      getStats: () => getStats(user),
      getLeads: () => getLeads(user, request.filters || {}),
      getTodaysFollowups: () => getTodaysFollowups(user),
      addLead: () => addLead(user, request.lead || {}),
      updateLead: () => updateLead(user, request.lead || {}),
      deleteLead: () => deleteLead(user, request.leadId)
    };

    if (!routes[action]) {
      return jsonResponse(fail('Invalid action.', 'INVALID_ACTION'));
    }

    return jsonResponse(ok(routes[action]()));
  } catch (error) {
    return jsonResponse(fail(error.message || 'Unexpected server error.', error.code || 'SERVER_ERROR'));
  }
}

function doGet() {
  return jsonResponse(fail('Use POST requests only.', 'METHOD_NOT_ALLOWED'));
}

function setupJajaborCrm() {
  const spreadsheet = getSpreadsheet();
  ensureSheet(spreadsheet, CONFIG.sheets.leads, CONFIG.leadHeaders);
  ensureSheet(spreadsheet, CONFIG.sheets.users, CONFIG.userHeaders);

  const users = readRows(CONFIG.sheets.users);
  if (!users.length) {
    const password = Utilities.getUuid().slice(0, 12);
    const salt = Utilities.getUuid();
    appendRow(CONFIG.sheets.users, {
      Username: 'admin',
      Name: 'Administrator',
      Role: CONFIG.roles.admin,
      'Password Hash': hashPassword(password, salt),
      Salt: salt,
      Active: 'TRUE'
    });
    Logger.log('Admin user created. Username: admin Password: %s', password);
  }

  ensureSecret();
  Logger.log('Setup complete. Deploy as a web app and paste the /exec URL into index.html app-config.');
}

function setUserPassword(username, newPassword) {
  requireNonEmpty(username, 'Username is required.');
  requireNonEmpty(newPassword, 'Password is required.');
  const table = readTable(CONFIG.sheets.users);
  const rowIndex = table.rows.findIndex((row) => row.Username === username);
  if (rowIndex < 0) throw new Error('User not found.');

  const salt = Utilities.getUuid();
  table.sheet.getRange(rowIndex + 2, table.headers.indexOf('Password Hash') + 1).setValue(hashPassword(newPassword, salt));
  table.sheet.getRange(rowIndex + 2, table.headers.indexOf('Salt') + 1).setValue(salt);
}

function createUser(username, name, role, password) {
  requireNonEmpty(username, 'Username is required.');
  requireNonEmpty(name, 'Name is required.');
  requireNonEmpty(password, 'Password is required.');
  if (![CONFIG.roles.admin, CONFIG.roles.agent].includes(role)) throw new Error('Invalid role.');
  const users = readRows(CONFIG.sheets.users);
  if (users.some((user) => user.Username === username)) throw new Error('Username already exists.');

  const salt = Utilities.getUuid();
  appendRow(CONFIG.sheets.users, {
    Username: username,
    Name: name,
    Role: role,
    'Password Hash': hashPassword(password, salt),
    Salt: salt,
    Active: 'TRUE'
  });
}

function authenticate(request) {
  const username = String(request.username || '').trim();
  const password = String(request.password || '');
  requireNonEmpty(username, 'Username is required.');
  requireNonEmpty(password, 'Password is required.');

  const userRow = readRows(CONFIG.sheets.users).find((user) => user.Username === username && isTruthy(user.Active));
  if (!userRow) return fail('Invalid credentials.', 'INVALID_CREDENTIALS');

  const expectedHash = String(userRow['Password Hash'] || '');
  const actualHash = hashPassword(password, String(userRow.Salt || ''));
  if (!constantTimeEqual(expectedHash, actualHash)) {
    return fail('Invalid credentials.', 'INVALID_CREDENTIALS');
  }

  const user = publicUser(userRow);
  return ok({
    token: signToken(user),
    expiresAt: Date.now() + CONFIG.tokenTtlMs,
    user
  });
}

function getOptions(user) {
  const users = readRows(CONFIG.sheets.users)
    .filter((row) => isTruthy(row.Active))
    .map((row) => row.Username);

  return {
    statuses: CONFIG.statuses,
    priorities: CONFIG.priorities,
    sources: CONFIG.sources,
    users: user.role === CONFIG.roles.admin ? ['Unassigned'].concat(users) : [user.username]
  };
}

function getStats(user) {
  const leads = visibleLeads(user, readRows(CONFIG.sheets.leads));
  const byStatus = countBy(leads, 'Status');
  const bySource = countBy(leads, 'Source');
  const byPriority = countBy(leads, 'Priority');
  const closed = Number(byStatus.Closed || 0);

  return {
    total: leads.length,
    byStatus,
    bySource,
    byPriority,
    conversionRate: leads.length ? Number(((closed / leads.length) * 100).toFixed(1)) : 0
  };
}

function getLeads(user, filters) {
  let leads = visibleLeads(user, readRows(CONFIG.sheets.leads));
  const status = String(filters.status || '').trim();
  const search = String(filters.search || '').trim().toLowerCase();

  if (status) leads = leads.filter((lead) => lead.Status === status);
  if (search) {
    leads = leads.filter((lead) => [lead.Name, lead.Phone, lead['Assigned To']]
      .some((value) => String(value || '').toLowerCase().includes(search)));
  }

  return leads
    .sort((a, b) => new Date(b['Last Updated'] || b['Date Added'] || 0) - new Date(a['Last Updated'] || a['Date Added'] || 0))
    .slice(0, CONFIG.maxPageSize);
}

function getTodaysFollowups(user) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return visibleLeads(user, readRows(CONFIG.sheets.leads))
    .filter((lead) => {
      if (!lead['Next Follow-up Date']) return false;
      const date = new Date(lead['Next Follow-up Date']);
      return !Number.isNaN(date.getTime()) && date <= today && lead.Status !== 'Closed';
    })
    .sort((a, b) => new Date(a['Next Follow-up Date']) - new Date(b['Next Follow-up Date']));
}

function addLead(user, lead) {
  const clean = sanitizeLead(lead);
  clean['Lead ID'] = `LEAD-${Date.now()}`;
  clean['Date Added'] = new Date().toISOString();
  clean['Created By'] = user.username;
  clean['Last Updated'] = new Date().toISOString();

  if (user.role !== CONFIG.roles.admin) {
    clean['Assigned To'] = user.username;
  }

  appendRow(CONFIG.sheets.leads, clean);
  return clean;
}

function updateLead(user, lead) {
  requireNonEmpty(lead.leadId, 'Lead ID is required.');
  const table = readTable(CONFIG.sheets.leads);
  const rowIndex = table.rows.findIndex((row) => row['Lead ID'] === lead.leadId);
  if (rowIndex < 0) throw new Error('Lead not found.');

  const existing = table.rows[rowIndex];
  assertCanEditLead(user, existing);
  const clean = sanitizeLead(lead);
  const merged = {
    ...existing,
    ...clean,
    'Lead ID': existing['Lead ID'],
    'Date Added': existing['Date Added'],
    'Created By': existing['Created By'],
    'Last Call Date': new Date().toISOString(),
    'Last Updated': new Date().toISOString()
  };

  if (user.role !== CONFIG.roles.admin) {
    merged['Assigned To'] = user.username;
  }

  writeRow(table.sheet, table.headers, rowIndex + 2, merged);
  return merged;
}

function deleteLead(user, leadId) {
  requireRole(user, CONFIG.roles.admin);
  requireNonEmpty(leadId, 'Lead ID is required.');
  const table = readTable(CONFIG.sheets.leads);
  const rowIndex = table.rows.findIndex((row) => row['Lead ID'] === leadId);
  if (rowIndex < 0) throw new Error('Lead not found.');
  table.sheet.deleteRow(rowIndex + 2);
  return { leadId };
}

function sanitizeLead(lead) {
  const phone = normalizePhone(lead.phone || lead.Phone);
  const status = pickAllowed(lead.status || lead.Status || 'New', CONFIG.statuses, 'New');
  const priority = pickAllowed(lead.priority || lead.Priority || 'Warm', CONFIG.priorities, 'Warm');
  const source = pickAllowed(lead.source || lead.Source || 'Manual', CONFIG.sources, 'Manual');
  const assignedTo = String(lead.assignedTo || lead['Assigned To'] || 'Unassigned').trim() || 'Unassigned';

  return {
    Name: cleanText(lead.name || lead.Name, 80),
    Phone: phone,
    Source: source,
    Status: status,
    Priority: priority,
    'Assigned To': assignedTo,
    'Next Follow-up Date': cleanDate(lead.nextFollowupDate || lead['Next Follow-up Date']),
    Remarks: cleanText(lead.remarks || lead.Remarks || '', 500)
  };
}

function assertCanEditLead(user, lead) {
  if (user.role === CONFIG.roles.admin) return;
  if (String(lead['Assigned To'] || '') === user.username) return;
  const error = new Error('You can only edit assigned leads.');
  error.code = 'FORBIDDEN';
  throw error;
}

function requireRole(user, role) {
  if (user.role === role) return;
  const error = new Error('You do not have permission for this action.');
  error.code = 'FORBIDDEN';
  throw error;
}

function visibleLeads(user, leads) {
  if (user.role === CONFIG.roles.admin) return leads;
  return leads.filter((lead) => String(lead['Assigned To'] || '') === user.username);
}

function parseRequest(event) {
  if (!event || !event.postData || !event.postData.contents) return {};
  return JSON.parse(event.postData.contents);
}

function verifyToken(token) {
  if (!token) unauthorized();
  const parts = String(token).split('.');
  if (parts.length !== 2) unauthorized();

  const payloadJson = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  const expectedSignature = sign(parts[0]);
  if (!constantTimeEqual(parts[1], expectedSignature)) unauthorized();

  const payload = JSON.parse(payloadJson);
  if (!payload.exp || Date.now() > Number(payload.exp)) unauthorized();
  return {
    username: payload.username,
    name: payload.name,
    role: payload.role
  };
}

function signToken(user) {
  const payload = {
    username: user.username,
    name: user.name,
    role: user.role,
    exp: Date.now() + CONFIG.tokenTtlMs
  };
  const encoded = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function sign(value) {
  const bytes = Utilities.computeHmacSha256Signature(value, ensureSecret());
  return Utilities.base64EncodeWebSafe(bytes);
}

function ensureSecret() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function hashPassword(password, salt) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    `${salt}:${password}`,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest);
}

function constantTimeEqual(left, right) {
  left = String(left || '');
  right = String(right || '');
  if (!left || !right) return false;
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= left.charCodeAt(index % left.length) ^ right.charCodeAt(index % right.length);
  }
  return diff === 0;
}

function unauthorized() {
  const error = new Error('Session expired. Please log in again.');
  error.code = 'UNAUTHORIZED';
  throw error;
}

function getSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  if (sheetId) return SpreadsheetApp.openById(sheetId);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheet(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const hasHeaders = headers.every((header, index) => firstRow[index] === header);
  if (!hasHeaders) {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readTable(sheetName) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Missing sheet: ${sheetName}`);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const rows = values.slice(1).filter((row) => row.some((cell) => cell !== '')).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index];
    });
    return item;
  });
  return { sheet, headers, rows };
}

function readRows(sheetName) {
  return readTable(sheetName).rows;
}

function appendRow(sheetName, data) {
  const table = readTable(sheetName);
  table.sheet.appendRow(table.headers.map((header) => data[header] || ''));
}

function writeRow(sheet, headers, rowNumber, data) {
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([headers.map((header) => data[header] || '')]);
}

function publicUser(row) {
  return {
    username: String(row.Username || ''),
    name: String(row.Name || row.Username || ''),
    role: String(row.Role || CONFIG.roles.agent)
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || 'Unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function cleanText(value, maxLength) {
  const text = String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (!text && maxLength <= 80) throw new Error('Name is required.');
  return text.slice(0, maxLength);
}

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  if (!/^\d{10}$/.test(phone)) throw new Error('Phone must be 10 digits.');
  return phone;
}

function cleanDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid follow-up date.');
  return date.toISOString();
}

function pickAllowed(value, allowed, fallback) {
  value = String(value || fallback).trim();
  return allowed.includes(value) ? value : fallback;
}

function requireNonEmpty(value, message) {
  if (String(value || '').trim() === '') throw new Error(message);
}

function isTruthy(value) {
  return String(value).toUpperCase() === 'TRUE' || value === true;
}

function ok(data) {
  return { success: true, message: 'OK', data };
}

function fail(message, code) {
  return { success: false, message, code: code || 'ERROR', data: null };
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
