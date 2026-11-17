'use strict';

const { createDemoRepository } = require('./demo');
const { createTableAdminRepository } = require('./table');

// Väljer datakälla. Demo måste vara explicit i produktion och får aldrig
// användas av misstag. Standard i icke-produktion är demo; standard i
// produktion är table.
function defaultSource(options = {}) {
  if (options.source) return options.source;
  if (process.env.ADMIN_DATA_SOURCE) return process.env.ADMIN_DATA_SOURCE;
  return process.env.NODE_ENV === 'production' ? 'table' : 'demo';
}

function createAdminRepository(options = {}) {
  const source = defaultSource(options);
  if (source === 'demo' && process.env.NODE_ENV === 'production') {
    throw new Error('Demodata får inte användas i produktion');
  }
  if (source === 'demo') {
    return createDemoRepository(options);
  }
  if (source === 'table') {
    return createTableAdminRepository(options);
  }
  throw new Error(`Okänd admin-datakälla: ${source}`);
}

module.exports = { createAdminRepository, defaultSource };
