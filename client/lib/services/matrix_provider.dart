import 'package:matrix/matrix.dart';

/// Client-owned Matrix provider.
///
/// It intentionally uses Matrix Dart SDK directly, matching the FluffyChat /
/// Extera architecture instead of tunnelling Matrix through the QQ bridge.
class MatrixProvider {
  MatrixProvider({String clientName = 'web-bridge'}) : client = Client(clientName);

  final Client client;

  Future<void> restore() async {
    await client.init();
  }
}
