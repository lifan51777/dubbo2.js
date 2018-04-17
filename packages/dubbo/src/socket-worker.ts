import debug from 'debug';
import net from 'net';
import Context from './context';
import {decode} from './decode';
import DecodeBuffer from './decode-buffer';
import DubboEncoder from './encode';
import HeartBeat from './heartbeat';
import {SOCKET_STATUS} from './socket-status';
import statistics from './statistics';
import {IObservable, ISocketSubscriber} from './types';

let pid = 0;
const noop = () => {};
const HEART_BEAT = 180 * 1000;
const log = debug('dubbo:socket-worker');

/**
 * 具体处理tcp底层通信的模块
 * 1 负责socket的创建和通信
 * 2.负责dubbo的序列化和反序列化
 */
export default class SocketWorker implements IObservable<ISocketSubscriber> {
  constructor(host: string, port: number) {
    this.pid = ++pid;
    statistics['pid#' + this.pid] = 0;

    this.host = host;
    this.port = port;
    this._isSending = false;
    this._status = SOCKET_STATUS.PADDING;

    log('create SocketWorker#%d addr: $s', pid, host + ':' + port);

    this._subscriber = {
      onConnect: noop,
      onData: noop,
      onClose: noop,
    };

    this._decodeBuff = DecodeBuffer.from(pid).subscribe(
      this._onSubscribeDecodeBuff,
    );
    this._initSocket();
  }

  public readonly pid: number;
  public readonly host: string;
  public readonly port: number;

  private _socket: net.Socket;
  private _isSending: boolean;
  private _status: number;
  private _decodeBuff: DecodeBuffer;
  private _subscriber: ISocketSubscriber;
  private _heartBeatTimer: NodeJS.Timer;

  static from(url: string) {
    const [host, port] = url.split(':');
    return new SocketWorker(host, parseInt(port));
  }

  private _initSocket() {
    log(`SocketWorker#${this.pid} =connecting=> ${this.host}:${this.port}`);

    this._socket = new net.Socket();
    this._socket.connect(this.port, this.host, this._onConnected);
    this._socket.on('data', this._onData);
    this._socket.on('error', this._onError);
    this._socket.on('close', this._onClose);
  }

  private _onSubscribeDecodeBuff = (data: Buffer) => {
    //反序列化dubbo
    const json = decode(data);
    log(`SocketWorker#${this.pid} <=received=> dubbo result %O`, json);
    this._subscriber.onData(json);
  };

  private _onConnected = () => {
    log(`SocketWorker#${this.pid} <=connected=> ${this.host}:${this.port}`);
    this._status = SOCKET_STATUS.CONNECTED;

    //通知外部连接成功
    this._subscriber.onConnect({
      pid: this.pid,
      host: this.host,
      port: this.port,
    });

    //心跳
    this._heartBeatTimer = setInterval(() => {
      //如果当前没有正在发送数据包，才发送心跳包
      if (!this._isSending) {
        log('emit heartbeat');
        this._socket.write(HeartBeat.encode());
      }
    }, HEART_BEAT);
  };

  private _onData = data => {
    log(`SocketWorker#${this.pid}  =receive data=> ${this.host}:${this.port}`);
    this._decodeBuff.receive(data);
  };

  private _onError = error => {
    log(`SocketWorker#${this.pid} <=occur error=> ${this.host}:${this.port}`);

    log(error);
    clearInterval(this._heartBeatTimer);
  };

  private _onClose = () => {
    log(`SocketWorker#${this.pid} <=closed=> ${this.host}:${this.port}`);

    this._status = SOCKET_STATUS.CLOSED;
    this._subscriber.onClose({
      pid: this.pid,
      host: this.host,
      port: this.port,
    });
    clearInterval(this._heartBeatTimer);
  };

  write(ctx: Context) {
    if (this.status === SOCKET_STATUS.CONNECTED) {
      log(`SocketWorker#${this.pid} =invoked=> ${ctx.requestId}`);
      statistics['pid#' + this.pid] = ++statistics['pid#' + this.pid];
      this._isSending = true;
      ctx.pid = this.pid;
      const encoder = new DubboEncoder(ctx);
      this._socket.write(encoder.encode());
      this._isSending = false;
    }
  }

  get status() {
    return this._status;
  }

  subscribe(subscriber: ISocketSubscriber) {
    this._subscriber = subscriber;
    return this;
  }
}
