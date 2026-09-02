import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

class ServerGateway {
  ServerGateway(this.endpoint, this.token);

  final Uri endpoint;
  final String token;
  WebSocketChannel? _channel;

  Stream<Map<String, dynamic>> get events => _channel!.stream.map((event) => jsonDecode(event as String) as Map<String, dynamic>);

  Future<void> connect() async {
    final uri = endpoint.replace(queryParameters: {...endpoint.queryParameters, 'token': token});
    final channel = WebSocketChannel.connect(uri);
    await channel.ready;
    _channel = channel;
    channel.sink.add(jsonEncode({
      'type': 'hello',
      'protocol': 1,
      'device_id': 'flutter-bootstrap',
    }));
  }

  void send(Map<String, dynamic> frame) => _channel?.sink.add(jsonEncode(frame));
  Future<void> close() async => _channel?.sink.close();
}
