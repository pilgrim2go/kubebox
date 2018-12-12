'use strict';

const crypto      = require('crypto'),
      HttpOptions = require('./http-options'),
      URI         = require('urijs');

class Client {

  constructor(master_api) {
    // should ideally be a defensive copy
    this.master_api = master_api;
    this.paths = [];
  }

  get master_api() {
    return this._master_api;
  }

  set master_api(master_api) {
    this.paths = [];
    this._master_api = master_api;
  }

  get headers() {
    return this.master_api.headers;
  }

  get url() {
    return this.master_api.url;
  }

  set url(url) {
    this.master_api.url = url;
  }

  get openshift() {
    return this.paths.some(path => path === '/oapi' || path === '/oapi/v1');
  }

  get token_url() {
    return this._token_url;
  }

  set token_url(url) {
    this._token_url = url;
  }

  set token_expiry_time(exp) {
    this._token_expiry_time = exp;
  }

  get token_expiry_time() {
    if (this._token_expiry_time)
      return this._token_expiry_time;
    this.jwt = this.master_api.auth_provider.token;
    return this._token_expiry_time;
  }

  set jwt(jwt) {
    this.master_api.auth_provider.token = jwt;
    this.master_api.headers['Authorization'] = `Bearer ${jwt}`;
    const part = jwt.split('.')[1];
    const payload = Buffer.from(part, 'base64');
    this.token_expiry_time = JSON.parse(payload).exp;
  }

  get jwt() {
    if (!this.master_api.auth_provider) {
      return this.master_api.auth_provider;
    }
    return this.master_api.auth_provider.token;
  }

  token_expired() {
    if (!this.master_api.auth_provider) {
      return false;
    }
    return (this.token_expiry_time - Date.now()/1000) < 10;
  }

  provider_configuration_url() {
    // https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig
    return new HttpOptions(this.master_api.auth_provider.url + '/.well-known/openid-configuration');
  }

  refresh_token() {
    const headers = {
      'content-type' : 'application/json'
    };
    const postData = {
      grant_type    : 'refresh_token',
      client_id     : `${this.master_api.auth_provider.client_id}`,
      client_secret : `${this.master_api.auth_provider.client_secret}`,
      refresh_token : `${this.master_api.auth_provider.refresh_token}`
    };
    return new HttpOptions(this.token_url, headers, 'POST', postData);
  }

  get_api() {
    const request = merge({
      path   : '/api',
      method : 'GET',
    },
    this.master_api);
    return {options: request, client: this};
  }

  get_paths({ authorization } = { authorization: true }) {
    const request = merge({
      path   : '/',
      method : 'GET',
    },
    this.master_api);
    if (!authorization && !this.jwt) {
      delete request.headers['Authorization'];
    }
    return {options: request, client: this};
  }

  // https://docs.openshift.org/latest/architecture/additional_concepts/authentication.html
  // https://github.com/openshift/openshift-docs/issues/707
  oauth_authorize({ username, password }) {
    delete this.master_api.headers['Authorization'];
    const request = merge({
        path    : '/oauth/authorize?client_id=openshift-challenging-client&response_type=token',
        method  : 'GET',
        auth    : `${username}:${password}`,
        headers : {
          'X-Csrf-Token' : '1',
        },
      }, this.master_api);
      return {options: request, client: this};
  }

  oauth_authorize_web({ username, password }) {
    delete this.master_api.headers['Authorization'];
    const request = merge({
        path    : `/oauth/authorize?client_id=openshift-browser-client&redirect_uri=${new URI(this.master_api.url).segment('/oauth/token/display')}&response_type=code`,
        method  : 'GET',
        auth    : `${username}:${password}`,
        headers : {
          'X-Csrf-Token' : '1',
        },
      }, this.master_api);
    return {options: request, client: this};
  }

  // token can be passed to test authentication
  get_user(token) {
    const request = merge({
      path    : '/oapi/v1/users/~',
      method  : 'GET',
      headers : {},
    }, this.master_api);
    if (token) {
      request.headers['Authorization'] = `Bearer ${token}`;
    }
    return {options: request, client: this};
  }

  get_namespaces() {
    const request = merge({
      path   : '/api/v1/namespaces',
      method : 'GET'
    }, this.master_api);
    return {options: request, client: this};
 }

  get_projects() {
    const request = merge({
      path   : '/oapi/v1/projects',
      method : 'GET'
    }, this.master_api);
    return {options: request, client: this};
  }

  get_pods(namespace) {
    const request = merge({
      path   : `/api/v1/namespaces/${namespace}/pods`,
      method : 'GET'
    }, this.master_api);
    return {options: request, client: this};
  }

  get_pod(namespace, name) {
    const request = merge({
      path   : `/api/v1/namespaces/${namespace}/pods/${name}`,
      method : 'GET'
    }, this.master_api);
    return {options: request, client: this};
  }

  watch_pods(namespace, resourceVersion) {
    const request = merge({
      path    : `/api/v1/namespaces/${namespace}/pods?watch=true&resourceVersion=${resourceVersion}`,
      method  : 'GET',
      headers : {
        // https://tools.ietf.org/html/rfc6455
        Origin                 : this.master_api.url,
        Connection             : 'Upgrade',
        Upgrade                : 'websocket',
        'Sec-WebSocket-Key'    : crypto.createHash('SHA1').digest('base64'),
        'Sec-WebSocket-Version': 13,
      }
    }, this.master_api);
    return {options: request, client: this};
  }

  watch_pod(namespace, name, resourceVersion) {
    const request = this.watch_pods(namespace, resourceVersion);
    request.path = URI(request.path)
      .addQuery('fieldSelector', `metadata.name=${name}`)
      .toString();
    return {options: request, client: this};
  }

  follow_log(namespace, name, { sinceTime, container } = {}) {
    // TODO: limit the amount of data with the limitBytes parameter
    const path = URI(`/api/v1/namespaces/${namespace}/pods/${name}/log?follow=true&tailLines=10000&timestamps=true`);
    if (container) path.addQuery('container', container);
    if (sinceTime) path.addQuery('sinceTime', sinceTime);
    const request = merge({
      path    : path.toString(),
      method  : 'GET',
      headers : {
        // https://tools.ietf.org/html/rfc6455
        Connection               : 'Upgrade',
        Upgrade                  : 'WebSocket',
        'Sec-WebSocket-Protocol' : 'binary.k8s.io',
        'Sec-WebSocket-Key'      : crypto.createHash('SHA1').digest('base64'),
        'Sec-WebSocket-Version'  : 13,
      }
    }, this.master_api);
    return {options: request, client: this};
  }

  exec(namespace, pod, { command = [], container } = {}) {
    const path = URI(`/api/v1/namespaces/${namespace}/pods/${pod}/exec`);
    path.addQuery('stdout', 1);
    path.addQuery('stdin', 1);
    path.addQuery('stderr', 1);
    path.addQuery('tty', 1);
    if (container) path.addQuery('container', container);
    command.forEach(c => path.addQuery('command', c));
    const request = merge({
      path    : path.toString(),
      method  : 'GET',
      headers : {
        // https://tools.ietf.org/html/rfc6455
        Connection               : 'Upgrade',
        Upgrade                  : 'WebSocket',
        'Sec-WebSocket-Protocol' : 'channel.k8s.io',
        'Sec-WebSocket-Key'      : crypto.createHash('SHA1').digest('base64'),
        'Sec-WebSocket-Version'  : 13,
      }
    }, this.master_api);
    return {options: request, client: this};
  }

  // Endpoints to resources usage metrics.
  //
  // The target is to rely on the Metrics API that is served by the Metrics server and accessed
  // from the the Master API.
  // See https://kubernetes.io/docs/tasks/debug-application-cluster/core-metrics-pipeline/
  //
  // However, the Metrics API is still limited and requires the Metrics server to be deployed
  // (default for clusters created by the kube-up.sh script).
  //
  // Design documentation can be found at the following location:
  // https://github.com/kubernetes/community/tree/master/contributors/design-proposals/instrumentation
  //
  // In the meantime, metrics are retrieved from the Kubelet /stats endpoint.

  // Gets the stats from the Summary API exposed by Kubelet on the specified node
  summary_stats(node) {
    const request = merge({
      path   : `/api/v1/nodes/${node}/proxy/stats/summary`,
      method : 'GET',
    }, this.master_api);
    return {options: request, client: this};
  }

  // Gets the cAdvisor data collected by Kubelet and exposed on the /stats endpoint.
  // It may be broken in previous k8s versions, see:
  // https://github.com/kubernetes/kubernetes/issues/56297
  // This cAdvisor endpoint will eventually be removed, see:
  // https://github.com/kubernetes/kubernetes/issues/68522
  container_stats(node, namespace, pod, uid, container) {
    const request = merge({
      path   : `/api/v1/nodes/${node}/proxy/stats/${namespace}/${pod}/${uid}/${container}`,
      method : 'GET',
    }, this.master_api);
    return {options: request, client: this};
  }
}

function merge(target, source) {
  return Object.keys(source).reduce((target, key) => {
    const prop = source[key];
    if (typeof prop === 'object' && Object.prototype.toString.call(prop) === '[object Object]') {
      // Only deep copy Object
      if (!target[key]) target[key] = {};
      merge(target[key], prop);
    } else if (typeof target[key] === 'undefined') {
      target[key] = prop;
    } else if (key === 'path' && source.path) {
      target.path = URI.joinPaths(source.path, target.path)
        .query(URI.parse(target.path).query || '')
        .resource();
    }
    return target;
  }, target);
}

module.exports = Client;
