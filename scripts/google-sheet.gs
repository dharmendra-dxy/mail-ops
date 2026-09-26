/**
 * MailOps — Google Sheets bridge (Apps Script web app).
 *
 * Gives the backend OAuth-free access to a Sheet: you authorise the script once
 * from your own Google account, then the backend talks to a plain HTTPS URL.
 *
 * Deploy:
 *   1. Open the target Google Sheet -> Extensions -> Apps Script.
 *   2. Delete the sample code, paste this whole file, and save.
 *   3. Deploy -> New deployment -> Type "Web app".
 *      Execute as: "Me"  |  Who has access: "Anyone".
 *   4. Copy the Web app URL into .env as GOOGLE_APPS_SCRIPT_URL.
 *
 * IMPORTANT after editing: Deploy -> Manage deployments -> Edit -> Version: New
 * version. A deployment pinned to an older version keeps serving the old code.
 *
 * The script is bound to the sheet it lives in, so a spreadsheetId sent by the
 * backend is used when accessible and otherwise the bound sheet is used
 * (the response reports which one was actually used).
 */

/** Bump this whenever the contract changes; it is echoed in every response. */
const BRIDGE_VERSION = '2026-09-27.1';

const SUPPORTED_ACTIONS = ['meta', 'read', 'update'];

function doGet() {
  return json_({
    ok: true,
    version: BRIDGE_VERSION,
    service: 'mailops-sheet-bridge',
    supportedActions: SUPPORTED_ACTIONS,
  });
}

function doPost(event) {
  var request = {};

  try {
    request = JSON.parse((event.postData && event.postData.contents) || '{}');
  } catch (parseError) {
    return json_({
      ok: false,
      version: BRIDGE_VERSION,
      error: 'Request body is not valid JSON: ' + parseError,
    });
  }

  try {
    var resolved = openSpreadsheet(request.spreadsheetId);
    var spreadsheet = resolved.spreadsheet;

    switch (request.action) {
      case 'meta':
        return json_({
          ok: true,
          version: BRIDGE_VERSION,
          resolvedSpreadsheetId: spreadsheet.getId(),
          warning: resolved.warning,
          sheetNames: listSheetNames_(spreadsheet),
        });

      case 'read': {
        var sheet = requireSheet_(spreadsheet, request.sheetName);
        var requested = typeof request.range === 'string' ? request.range.trim() : '';

        // No range means "the whole tab". getDataRange() is used instead of a
        // sheet-name range because a bare tab name is not a valid A1 range on
        // every Apps Script runtime.
        var values = requested
          ? sheet.getRange(requested).getDisplayValues()
          : sheet.getDataRange().getDisplayValues();

        return json_({
          ok: true,
          version: BRIDGE_VERSION,
          resolvedSpreadsheetId: spreadsheet.getId(),
          warning: resolved.warning,
          rows: values,
        });
      }

      case 'update': {
        var targetSheet = requireSheet_(spreadsheet, request.sheetName);
        var newValues = request.values || [];

        if (typeof request.range !== 'string' || !request.range.trim()) {
          throw new Error('range is required for the update action');
        }

        var target = targetSheet.getRange(request.range.trim());

        // Force plain text so ISO timestamps and message ids are stored
        // verbatim instead of being re-interpreted by Sheets as dates/numbers.
        target.setNumberFormat('@');
        target.setValues(newValues);

        return json_({
          ok: true,
          version: BRIDGE_VERSION,
          resolvedSpreadsheetId: spreadsheet.getId(),
          warning: resolved.warning,
          updatedCells: countCells_(newValues),
        });
      }

      default:
        return json_({
          ok: false,
          version: BRIDGE_VERSION,
          error:
            'Unsupported action "' + request.action + '". Supported: ' + SUPPORTED_ACTIONS.join(', '),
        });
    }
  } catch (error) {
    return json_({
      ok: false,
      version: BRIDGE_VERSION,
      action: request.action,
      error: describe_(error),
    });
  }
}

function countCells_(values) {
  var total = 0;

  for (var i = 0; i < values.length; i += 1) {
    total += (values[i] || []).length;
  }

  return total;
}

function describe_(error) {
  var message = (error && error.message) || String(error);

  return '[' + (error && error.name ? error.name : 'Error') + '] ' + message;
}

function openSpreadsheet(spreadsheetId) {
  if (spreadsheetId) {
    try {
      return { spreadsheet: SpreadsheetApp.openById(spreadsheetId), warning: '' };
    } catch (error) {
      var active = SpreadsheetApp.getActiveSpreadsheet();
      if (active) {
        return {
          spreadsheet: active,
          warning:
            'Spreadsheet ' + spreadsheetId + ' is not shared with this script; ' +
            'fell back to the bound spreadsheet ' + active.getId() + '.',
        };
      }
      throw new Error(
        'Cannot open spreadsheet ' + spreadsheetId + ' and no bound spreadsheet is available. ' +
          'Share the sheet with the account that owns this script.',
      );
    }
  }

  var bound = SpreadsheetApp.getActiveSpreadsheet();
  if (!bound) {
    throw new Error('This script is not bound to a spreadsheet and no spreadsheetId was supplied.');
  }

  return { spreadsheet: bound, warning: '' };
}

function listSheetNames_(spreadsheet) {
  return spreadsheet.getSheets().map(function (sheet) {
    return sheet.getName();
  });
}

function requireSheet_(spreadsheet, sheetName) {
  if (!sheetName) {
    throw new Error('sheetName is required.');
  }

  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      'Tab "' + sheetName + '" not found. Available tabs: ' + listSheetNames_(spreadsheet).join(', '),
    );
  }

  return sheet;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
