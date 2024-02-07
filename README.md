# doh-proxy

**doh-proxy** is a simple DNS-over-HTTPS proxy server that allows you to securely resolve DNS queries over HTTPS, while enhancing privacy by spreading your queries over many upstream services (ensuring no service has access to all your data) and security by encrypting your DNS traffic, preventing eavesdropping and tampering.

## Features

* **Easy to Deploy:** Powered by Cloudflare Workers, deploy via wrangler or your CI of choice;
* **Privacy:** Ensure no third party can profile you by spreading your data randomly through many upstreams. Hide in the crowd;
* **Security:** Encrypts DNS traffic to protect against eavesdropping and tampering;

## Contributing
Contributions are welcome! Please fork the repository and submit a pull request.

## License
This project is licensed under the Apache License 2.0 - see the LICENSE file for details.