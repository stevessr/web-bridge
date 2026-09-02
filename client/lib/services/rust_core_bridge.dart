import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../src/rust/api.dart' as rust_api;
import '../src/rust/frb_generated.dart';

typedef CoreFrame = Map<String, dynamic>;

class RustCoreBridge {
  RustCoreBridge({FlutterSecureStorage? secureStorage})
    : _secureStorage = secureStorage ?? const FlutterSecureStorage();

  static const _deviceIdStorageKey = 'web_bridge.device_id';

  final FlutterSecureStorage _secureStorage;
  final StreamController<CoreFrame> _events =
      StreamController<CoreFrame>.broadcast();

  Timer? _pollTimer;
  bool _initialized = false;

  Stream<CoreFrame> get events => _events.stream;

  Future<void> init() async {
    if (_initialized) {
      return;
    }
    await RustLib.init();
    _initialized = true;
    _pollTimer = Timer.periodic(
      const Duration(milliseconds: 150),
      (_) => _drainEvents(),
    );
  }

  int get protocolVersion => rust_api.protocolVersion();

  bool routeIsAllowed(String network, String route) =>
      rust_api.routeIsAllowed(network: network, route: route);

  Future<void> connect({
    required String endpoint,
    required String token,
  }) async {
    await rust_api.connectServer(
      endpoint: endpoint,
      token: token,
      deviceId: await _deviceId(),
    );
  }

  void disconnect() => rust_api.disconnectServer();

  Future<void> execute(Map<String, dynamic> command) async {
    final raw = await rust_api.executeCommandJson(
      commandJson: jsonEncode(command),
    );
    _emitCommandResult(raw);
  }

  List<CoreFrame> listAccounts() {
    final decoded = jsonDecode(rust_api.listAccountsJson());
    if (decoded is! List) {
      throw const FormatException('Rust account registry was not a JSON list');
    }
    return decoded
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }

  void dispose() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _events.close();
    if (_initialized) {
      RustLib.dispose();
      _initialized = false;
    }
  }

  void _drainEvents() {
    if (!_initialized || _events.isClosed) {
      return;
    }
    try {
      final decoded = jsonDecode(rust_api.drainEventsJson());
      if (decoded is! List) {
        throw const FormatException('Rust event queue was not a JSON list');
      }
      for (final raw in decoded.whereType<Map>()) {
        _events.add(Map<String, dynamic>.from(raw));
      }
    } catch (error) {
      _events.add(<String, dynamic>{
        'type': 'error',
        'code': 'flutter_rust_event_bridge',
        'message': error.toString(),
      });
    }
  }

  void _emitCommandResult(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! List) {
      // Remote commands return forwarding metadata. Their Ack/Error/AuthChallenge
      // arrives asynchronously through the Rust RemoteBridge event queue.
      return;
    }
    for (final frame in decoded.whereType<Map>()) {
      _events.add(Map<String, dynamic>.from(frame));
    }
  }

  Future<String> _deviceId() async {
    try {
      final existing = await _secureStorage.read(key: _deviceIdStorageKey);
      if (existing != null && existing.isNotEmpty) {
        return existing;
      }
      final generated = _newDeviceId();
      await _secureStorage.write(
        key: _deviceIdStorageKey,
        value: generated,
      );
      return generated;
    } catch (_) {
      return _newDeviceId();
    }
  }

  String _newDeviceId() {
    final random = Random.secure();
    final bytes = List<int>.generate(18, (_) => random.nextInt(256));
    return 'flutter-${base64Url.encode(bytes).replaceAll('=', '')}';
  }
}
