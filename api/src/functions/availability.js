'use strict';

const { app } = require('@azure/functions');
const { handleAvailability } = require('../availability');

app.http('availability', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handleAvailability
});
