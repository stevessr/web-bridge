import 'dart:convert';

import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class ServerGateway {
  ServerGateway(this.endpoint, this.token);

  final Uri endpoint;
  final String token;
  final _uuid = const Uuid();
  WebSocketChannel? _channel;

  Stream<Map<String, dynamic>> get events => _channel!.stream.map(
        (event) => jsonDecode(event as String) as Map<String, dynamic>,
      );

  Future<void> connect() async {
    final uri = endpoint.replace(
      queryParameters: {...endpoint.queryParameters, 'token': token},
    );
    final channel = WebSocketChannel.connect(uri);
    await channel.ready;
    _channel = channel;
    channel.sink.add(jsonEncode({
      'type': 'hello',
      'protocol': 2,
      'device_id': 'flutter',
    }));
  }

  String listAccounts() => _command({'type': 'list_accounts'});

  String registerAccount({
    required String network,
    required String accountId,
    required String route,
    String? displayName,
  }) =>
      _command({
        'type': 'register_account',
        'account': {'network': network, 'id': accountId},
        'display_name': displayName,
        'route': route,
      });

  String removeAccount({required String network, required String accountId}) =>
      _command({
        'type': 'remove_account',
        'account': {'network': network, 'id': accountId},
      });

  String setAccountRoute({
    required String network,
    required String accountId,
    required String route,
  }) =>
      _command({
        'type': 'set_account_route',
        'account': {'network': network, 'id': accountId},
        'route': route,
      });

  String _command(Map<String, dynamic> command) {
    final requestId = _uuid.v4();
    send({
      'type': 'command',
      'request_id': requestId,
      'command': command,
    });
    return requestId;
  }

  void send(Map<String, dynamic> frame) =>
      _channel?.sink.add(jsonEncode(frame));

  Future<void> close() async => _channel?.sink.close();
}
