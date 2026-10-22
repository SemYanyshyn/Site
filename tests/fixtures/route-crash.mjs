// Error-path fixture only; successful/cancelled/timed-out runs use the real search.
throw new Error('Intentional worker failure for executor recovery verification.');
