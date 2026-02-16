import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class PaymentsRecord extends FirestoreRecord {
  PaymentsRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "amount" field.
  double? _amount;
  double get amount => _amount ?? 0.0;
  bool hasAmount() => _amount != null;

  // "date" field.
  DateTime? _date;
  DateTime? get date => _date;
  bool hasDate() => _date != null;

  // "client" field.
  DocumentReference? _client;
  DocumentReference? get client => _client;
  bool hasClient() => _client != null;

  // "clientData" field.
  ClientDataStruct? _clientData;
  ClientDataStruct get clientData => _clientData ?? ClientDataStruct();
  bool hasClientData() => _clientData != null;

  // "workerData" field.
  WorkerDataStruct? _workerData;
  WorkerDataStruct get workerData => _workerData ?? WorkerDataStruct();
  bool hasWorkerData() => _workerData != null;

  // "payment_method" field.
  String? _paymentMethod;
  String get paymentMethod => _paymentMethod ?? '';
  bool hasPaymentMethod() => _paymentMethod != null;

  // "discount" field.
  double? _discount;
  double get discount => _discount ?? 0.0;
  bool hasDiscount() => _discount != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  void _initializeFields() {
    _amount = castToType<double>(snapshotData['amount']);
    _date = snapshotData['date'] as DateTime?;
    _client = snapshotData['client'] as DocumentReference?;
    _clientData = snapshotData['clientData'] is ClientDataStruct
        ? snapshotData['clientData']
        : ClientDataStruct.maybeFromMap(snapshotData['clientData']);
    _workerData = snapshotData['workerData'] is WorkerDataStruct
        ? snapshotData['workerData']
        : WorkerDataStruct.maybeFromMap(snapshotData['workerData']);
    _paymentMethod = snapshotData['payment_method'] as String?;
    _discount = castToType<double>(snapshotData['discount']);
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('payments');

  static Stream<PaymentsRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => PaymentsRecord.fromSnapshot(s));

  static Future<PaymentsRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => PaymentsRecord.fromSnapshot(s));

  static PaymentsRecord fromSnapshot(DocumentSnapshot snapshot) =>
      PaymentsRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static PaymentsRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      PaymentsRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'PaymentsRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is PaymentsRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createPaymentsRecordData({
  double? amount,
  DateTime? date,
  DocumentReference? client,
  ClientDataStruct? clientData,
  WorkerDataStruct? workerData,
  String? paymentMethod,
  double? discount,
  DocumentReference? accomodation,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'amount': amount,
      'date': date,
      'client': client,
      'clientData': ClientDataStruct().toMap(),
      'workerData': WorkerDataStruct().toMap(),
      'payment_method': paymentMethod,
      'discount': discount,
      'accomodation': accomodation,
    }.withoutNulls,
  );

  // Handle nested data for "clientData" field.
  addClientDataStructData(firestoreData, clientData, 'clientData');

  // Handle nested data for "workerData" field.
  addWorkerDataStructData(firestoreData, workerData, 'workerData');

  return firestoreData;
}

class PaymentsRecordDocumentEquality implements Equality<PaymentsRecord> {
  const PaymentsRecordDocumentEquality();

  @override
  bool equals(PaymentsRecord? e1, PaymentsRecord? e2) {
    return e1?.amount == e2?.amount &&
        e1?.date == e2?.date &&
        e1?.client == e2?.client &&
        e1?.clientData == e2?.clientData &&
        e1?.workerData == e2?.workerData &&
        e1?.paymentMethod == e2?.paymentMethod &&
        e1?.discount == e2?.discount &&
        e1?.accomodation == e2?.accomodation;
  }

  @override
  int hash(PaymentsRecord? e) => const ListEquality().hash([
        e?.amount,
        e?.date,
        e?.client,
        e?.clientData,
        e?.workerData,
        e?.paymentMethod,
        e?.discount,
        e?.accomodation
      ]);

  @override
  bool isValidKey(Object? o) => o is PaymentsRecord;
}
