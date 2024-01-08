import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
import dnsPacket from 'dns-packet';
import Config from '../config.json';
import Resolvers from '../resolvers.json';
import Package from '../package-lock.json';

const router = Router();

Array.prototype.sample = function(){
	return this[Math.floor(Math.random()*this.length)];
}

Array.prototype.sampleN = function(n: any) {
	var result = new Array(n),
		len = this.length,
		taken = new Array(len);
	if (n > len)
		throw new RangeError("getRandom: more elements taken than available");
	while (n--) {
		var x = Math.floor(Math.random() * len);
		result[n] = this[x in taken ? taken[x] : x];
		taken[x] = --len in taken ? taken[len] : len;
	}
	return result;
}

function chooseResolvers(resolvers: any, q: any, n: any = 3) {
	let p = [];
	if (resolvers.length > n) {
		for (let r of resolvers.sampleN(n)) {
			p.push(fetch(`${Resolvers[r]}?dns=${q}`, {
				headers: {
					'Content-Type': 'application/dns-message'
				}
			}))
		}
	}
	else {
		// Otherwise, pick one
		p.push(fetch(`${Resolvers[resolver.sample()]}?dns=${q}`, {
			headers: {
				'Content-Type': 'application/dns-message'
			}
		}))
	}

	return p;
}

router.all('/dns-query', async (request, env, context) => {
	// First, grab some request information
	let url: any = new URL(request.url)

	// Now, we refuse anything that isn't GET or POST
	if (!['GET', 'POST'].includes(request.method)) {
		return new Response('Not Found.', { status: 404 })
	}

	// And grab the question
	let q: any = null;
	if (request.method == 'GET') {
		if (request.query.dns) {
			q = request.query.dns;
		}
		else {
			return new Response('Missing query in ?dns=', { status: 400 })
		}
	}
	if (request.method == 'POST') {
		q = await request.arrayBuffer();
		q = Buffer.from(q);
	}

	// Now, to validate the payload
	let t: any;
	try {
		t = Buffer.from(q, 'base64');
		t = dnsPacket.decode(t);
	}
	catch(e: any) {
		return new Response('Invalid query', { status: 500 })
	}

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default'].resolvers
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}

	if (request.method == 'POST') q = q.toString('base64').replace(/=+/, '');
	let providers = chooseResolvers(resolver, q);
	
	// And send it off
	let answer: any;
	try {
		answer = await Promise.any(providers);
	}
	catch(e: any) {
		return new Response('We encountered a server error. Please try again later', { status: 500 })
	}

	// Once we have an answer, we return that
	let a = await answer.arrayBuffer();
	return new Response(a, {
		headers: {
			'Content-Type': answer.headers.get('Content-Type'),
			'X-Provider': new URL(answer.url).hostname
		},
		status: answer.status
	})
})

router.get('/dns-providers', async (request) => {

	// First, grab some request information
	let url: any = new URL(request.url);

	// Now, prepare a payload
	let resp: any = {
		'providers': []
	}

	// Next, we prepare to send it on, first pick a resolver (set to our default set)
	let resolver: any = Config['default'].resolvers;
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}
	
	// Add each provider to the response, so they can be seen
	for (let r of resolver) {
		resp.providers.push(Resolvers[r])
	}

	// And return that data
	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

router.get('/version', async (request) => {
	return new Response(Package.version, {
		headers: {
			'Content-Type': 'text/plain'
		}
	})
});

router.get('/', async (request) => {
	// First, we grab the hostname they asked for
	let hostname: any = new URL(request.url).hostname
	let resolver: any = Config['default'].resolvers;
	if (Config[hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[hostname].resolvers;
	}

	// Now to grab the resolver URLs
	let resolvers: any = [];
	for (let r of resolver) {
		resolvers.push(Resolvers[r])
	}

	// This is going to be an amazing hack so I don't have to mess with KV
	let data: any = await fetch('https://mydns.network/_resolver.html', {
		cf: {
			cacheTtl: 3600,
			cacheEverything: true,
		}
	})
	data = await data.text()

	// And now we make some changes to the stored HTML
	data = data.replaceAll('[HOSTNAME]', hostname);
	data = data.replaceAll('[RESOLVERS]', resolvers.join('\n'))

	// And craft a new response
	return new Response(data, {
		headers: {
			'Content-Type': 'text/html'
		}
	})
});

router.all("*", () => new Response("404, not found!", { status: 404 }))

export default {
	fetch: router.handle
}
