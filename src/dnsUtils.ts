function toType(type: any) {
	switch (type.toUpperCase()) {
		case 'A': return 1
		case 'NULL': return 10
		case 'AAAA': return 28
		case 'AFSDB': return 18
		case 'APL': return 42
		case 'CAA': return 257
		case 'CDNSKEY': return 60
		case 'CDS': return 59
		case 'CERT': return 37
		case 'CNAME': return 5
		case 'DHCID': return 49
		case 'DLV': return 32769
		case 'DNAME': return 39
		case 'DNSKEY': return 48
		case 'DS': return 43
		case 'HIP': return 55
		case 'HINFO': return 13
		case 'IPSECKEY': return 45
		case 'KEY': return 25
		case 'KX': return 36
		case 'LOC': return 29
		case 'MX': return 15
		case 'NAPTR': return 35
		case 'NS': return 2
		case 'NSEC': return 47
		case 'NSEC3': return 50
		case 'NSEC3PARAM': return 51
		case 'PTR': return 12
		case 'RRSIG': return 46
		case 'RP': return 17
		case 'SIG': return 24
		case 'SOA': return 6
		case 'SPF': return 99
		case 'SRV': return 33
		case 'SSHFP': return 44
		case 'TA': return 32768
		case 'TKEY': return 249
		case 'TLSA': return 52
		case 'TSIG': return 250
		case 'TXT': return 16
		case 'AXFR': return 252
		case 'IXFR': return 251
		case 'OPT': return 41
		case 'ANY': return 255
		case '*': return 255
	}
	if (type.toUpperCase().startsWith('UNKNOWN_')) return parseInt(name.slice(8))
	return 0
}

function toRcode(code: any) {
	switch (code.toUpperCase()) {
		case 'NOERROR': return 0
		case 'FORMERR': return 1
		case 'SERVFAIL': return 2
		case 'NXDOMAIN': return 3
		case 'NOTIMP': return 4
		case 'REFUSED': return 5
		case 'YXDOMAIN': return 6
		case 'YXRRSET': return 7
		case 'NXRRSET': return 8
		case 'NOTAUTH': return 9
		case 'NOTZONE': return 10
		case 'RCODE_11': return 11
		case 'RCODE_12': return 12
		case 'RCODE_13': return 13
		case 'RCODE_14': return 14
		case 'RCODE_15': return 15
	}
	return 0
}

export { toType, toRcode }