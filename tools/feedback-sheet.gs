// Google Apps Script that turns a Google Sheet into the feedback inbox for the SEND FEEDBACK button.
// Setup: open a new Sheet -> Extensions -> Apps Script -> paste this -> Deploy -> New deployment ->
// Web app, execute as Me, access: Anyone -> copy the /exec URL into FEEDBACK.endpoint in js/main.js.
// Each submission becomes one row. The header row is created on the first submission.

var COLUMNS = ['time', 'kind', 'message', 'contact', 'where', 'version', 'page', 'sessionMin', 'browser', 'lang',
  'screen', 'gpu', 'input', 'rules', 'picks', 'fight', 'career', 'errors'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(COLUMNS);
      sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    var row = COLUMNS.map(function (k) {
      var v = data[k];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).slice(0, 5000);
    });
    sheet.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Lets you open the URL in a browser to check the deployment is alive.
function doGet() {
  return ContentService.createTextOutput('Cage Rules feedback inbox is up.');
}
