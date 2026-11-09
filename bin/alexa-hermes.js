#!/usr/bin/env node
'use strict';
require('../src/cli')
    .main(process.argv.slice(2))
    .then((code) => {
        if (typeof code === 'number') process.exit(code);
    })
    .catch((e) => {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
    });
