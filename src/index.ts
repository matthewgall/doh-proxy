import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
import { dnsPacket } from 'dns-packet';
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

function chooseResolvers(resolvers: any, q: any) {
	let p = [];
	if (resolvers.length > 3) {
		// We are going to race three for a response
		for (let r of resolvers.sampleN(3)) {
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

router.get('/dns-query', async (request) => {
	
	// First, grab some request information
	let url: any = new URL(request.url)

	// And grab the question
	let q: any = null;
	if (request.query.dns) {
		q = request.query.dns;
	}
	else {
		return new Response('Missing query in ?dns=', { status: 400 })
	}

	// Now, to validate the payload
	try {
		let t: any = Buffer.from(q)
		t = dnsPacket.decode(t);
	}
	catch(e: any) {

		return new Response('Invalid query', { status: 500 })
	}

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default']
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname]
	}

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
	return answer;
})

router.post('/dns-query', async (request) => {

	// First, grab some request information
	let url: any = new URL(request.url);

	// First, we grab the question
	let q: any = await request.arrayBuffer();
	q = Buffer.from(q);

	// Now, to validate the payload
	try {
		let t: any = dnsPacket.decode(q);
	}
	catch(e: any) {
		return new Response('Invalid query', { status: 500 })
	}

	// Now, prepare the payload
	q = q.toString('base64').replace(/=+/, '');

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default']
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname]
	}

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
			'Content-Type': 'application/dns-message'
		},
		status: answer.status_code
	})
	// return answer;
})

router.get('/dns-providers', async (request) => {

	// First, grab some request information
	let url: any = new URL(request.url);

	// Now, prepare a payload
	let resp: any = {
		'providers': []
	}

	// Next, we prepare to send it on, first pick a resolver (set to our default set)
	let resolver: any = Config['default'];
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname]
	}
	
	// Add each provider to the response, so they can be seen
	for (let r of resolver) {
		resp.providers.push(Resolvers[r])
	}

	// And return that data
	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

router.get('/', async (request) => {
	return new Response(`Welcome to ${Package.name}`)
});

router.all("*", () => new Response("404, not found!", { status: 404 }))

export default {
    fetch: router.handle
}
