import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class SalesRecord extends FirestoreRecord {
  SalesRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "amount" field.
  double? _amount;
  double get amount => _amount ?? 0.0;
  bool hasAmount() => _amount != null;

  // "create_time" field.
  DateTime? _createTime;
  DateTime? get createTime => _createTime;
  bool hasCreateTime() => _createTime != null;

  // "client" field.
  ClientDataStruct? _client;
  ClientDataStruct get client => _client ?? ClientDataStruct();
  bool hasClient() => _client != null;

  // "products" field.
  List<ProductDataStruct>? _products;
  List<ProductDataStruct> get products => _products ?? const [];
  bool hasProducts() => _products != null;

  // "service" field.
  ServiceDataStruct? _service;
  ServiceDataStruct get service => _service ?? ServiceDataStruct();
  bool hasService() => _service != null;

  // "refunded" field.
  bool? _refunded;
  bool get refunded => _refunded ?? false;
  bool hasRefunded() => _refunded != null;

  // "refund_amount" field.
  double? _refundAmount;
  double get refundAmount => _refundAmount ?? 0.0;
  bool hasRefundAmount() => _refundAmount != null;

  // "refund_date" field.
  DateTime? _refundDate;
  DateTime? get refundDate => _refundDate;
  bool hasRefundDate() => _refundDate != null;

  // "refund_reason" field.
  String? _refundReason;
  String get refundReason => _refundReason ?? '';
  bool hasRefundReason() => _refundReason != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  void _initializeFields() {
    _amount = castToType<double>(snapshotData['amount']);
    _createTime = snapshotData['create_time'] as DateTime?;
    _client = snapshotData['client'] is ClientDataStruct
        ? snapshotData['client']
        : ClientDataStruct.maybeFromMap(snapshotData['client']);
    _products = getStructList(
      snapshotData['products'],
      ProductDataStruct.fromMap,
    );
    _service = snapshotData['service'] is ServiceDataStruct
        ? snapshotData['service']
        : ServiceDataStruct.maybeFromMap(snapshotData['service']);
    _refunded = snapshotData['refunded'] as bool?;
    _refundAmount = castToType<double>(snapshotData['refund_amount']);
    _refundDate = snapshotData['refund_date'] as DateTime?;
    _refundReason = snapshotData['refund_reason'] as String?;
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('sales');

  static Stream<SalesRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => SalesRecord.fromSnapshot(s));

  static Future<SalesRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => SalesRecord.fromSnapshot(s));

  static SalesRecord fromSnapshot(DocumentSnapshot snapshot) => SalesRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static SalesRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      SalesRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'SalesRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is SalesRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createSalesRecordData({
  double? amount,
  DateTime? createTime,
  ClientDataStruct? client,
  ServiceDataStruct? service,
  bool? refunded,
  double? refundAmount,
  DateTime? refundDate,
  String? refundReason,
  DocumentReference? accomodation,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'amount': amount,
      'create_time': createTime,
      'client': ClientDataStruct().toMap(),
      'service': ServiceDataStruct().toMap(),
      'refunded': refunded,
      'refund_amount': refundAmount,
      'refund_date': refundDate,
      'refund_reason': refundReason,
      'accomodation': accomodation,
    }.withoutNulls,
  );

  // Handle nested data for "client" field.
  addClientDataStructData(firestoreData, client, 'client');

  // Handle nested data for "service" field.
  addServiceDataStructData(firestoreData, service, 'service');

  return firestoreData;
}

class SalesRecordDocumentEquality implements Equality<SalesRecord> {
  const SalesRecordDocumentEquality();

  @override
  bool equals(SalesRecord? e1, SalesRecord? e2) {
    const listEquality = ListEquality();
    return e1?.amount == e2?.amount &&
        e1?.createTime == e2?.createTime &&
        e1?.client == e2?.client &&
        listEquality.equals(e1?.products, e2?.products) &&
        e1?.service == e2?.service &&
        e1?.refunded == e2?.refunded &&
        e1?.refundAmount == e2?.refundAmount &&
        e1?.refundDate == e2?.refundDate &&
        e1?.refundReason == e2?.refundReason &&
        e1?.accomodation == e2?.accomodation;
  }

  @override
  int hash(SalesRecord? e) => const ListEquality().hash([
        e?.amount,
        e?.createTime,
        e?.client,
        e?.products,
        e?.service,
        e?.refunded,
        e?.refundAmount,
        e?.refundDate,
        e?.refundReason,
        e?.accomodation
      ]);

  @override
  bool isValidKey(Object? o) => o is SalesRecord;
}
